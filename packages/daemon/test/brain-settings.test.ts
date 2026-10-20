import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { createFullTestDb } from './helpers/test-app.js';
import { RigRepository } from '../src/domain/rig-repository.js';
import { EventBus } from '../src/domain/event-bus.js';
import { BrainSettingsService } from '../src/domain/brain-settings-service.js';
import { Hono } from 'hono';
import { brainSettingsRoutes } from '../src/routes/brain-settings.js';

let db: ReturnType<typeof createFullTestDb>;
beforeEach(()=>{db=createFullTestDb();});
afterEach(()=>db.close());
function fixture(){
  const repo=new RigRepository(db),events=new EventBus(db);
  const rig=repo.createRig('fixture'); const node=repo.addNode(rig.id,'dev.agent',{runtime:'codex',cwd:'/fixture',model:'fixture-model'});
  const worker=vi.fn(async(action:string,input:any)=>{
    if(action==='status')return {providers:[{id:'openai',label:'OpenAI',runtime:'codex',available:true,activeAccount:'primary',accounts:[{name:'primary',active:true,loginPresent:true},{name:'work',active:false,loginPresent:true}],models:[],efforts:['low','medium','high']},{id:'claude',label:'Claude',runtime:'claude-code',available:true,activeAccount:'personal',accounts:[{name:'personal',active:true,loginPresent:true}],models:[],efforts:['low','medium','high']} ]};
    if(action==='inventory')return [{rigId:rig.id,rigName:'fixture',logicalId:'dev.agent',canonicalSessionName:'dev-agent@fixture',runtime:'codex',sessionStatus:'running',resumeTokenPresent:true,agentActivity:{state:'idle'}}];
    if(action==='plan')return {outcome:'plan',affectedSeats:['dev-agent@fixture'],rigs:[rig.id]};
    if(action==='switch')return {outcome:'resumed'};
    throw Error('unexpected_worker_operation');
  });
  const handover=vi.fn(async()=>({ok:true,result:{}}));
  const lifecycle={effortReport:async()=>({ok:true,saved:{effective:null},observed:{state:'unknown'},emitted:{state:'unknown'}})};
  const service=new BrainSettingsService({rigRepo:repo,eventBus:events,worker,lifecycle:lifecycle as any,handover:()=>({handover}) as any});
  return {service,repo,rig,node,worker,handover,events};
}
it('previews impact without saving settings or stopping agents',async()=>{
  const f=fixture();
  const plan=await f.service.plan(f.rig.id,'dev.agent',{provider:'openai',account:'work',model:'fixture-new',effort:'high',mode:'apply'});
  expect(plan.affectedSeats).toEqual(['dev-agent@fixture']); expect(plan.sharedAccount).toBe(true);
  expect((db.prepare('SELECT model FROM nodes WHERE id=?').get(f.node.id) as any).model).toBe('fixture-model');
  expect(f.worker.mock.calls.some(c=>c[0]==='switch')).toBe(false);
});
it('requires confirmation and consumes a preview once before starting one asynchronous operation',async()=>{
  const f=fixture(); const p=await f.service.plan(f.rig.id,'dev.agent',{provider:'openai',account:'primary',model:null,effort:'high',mode:'save'});
  await expect(f.service.apply(f.rig.id,'dev.agent',p.planId,false)).rejects.toThrow('confirmation_required');
  const {operationId}=await f.service.apply(f.rig.id,'dev.agent',p.planId,true);
  await vi.waitFor(()=>expect(f.service.operation(operationId).status).toBe('completed'));
  expect(db.prepare('SELECT model,effort_choice FROM nodes WHERE id=?').get(f.node.id)).toMatchObject({model:null,effort_choice:'high'});
  expect(f.worker.mock.calls.some(c=>c[0]==='switch')).toBe(false);
  await expect(f.service.apply(f.rig.id,'dev.agent',p.planId,true)).rejects.toThrow('preview_expired');
});
it('notifies subscribers after saved settings are committed',async()=>{
  const f=fixture();const seen:string[]=[];
  f.events.subscribe(event=>{if(event.type==='node.effort_changed')seen.push('effort');});
  const p=await f.service.plan(f.rig.id,'dev.agent',{provider:'openai',account:'primary',model:null,effort:'high',mode:'save'});
  const op=await f.service.apply(f.rig.id,'dev.agent',p.planId,true);
  await vi.waitFor(()=>expect(f.service.operation(op.operationId).status).toBe('completed'));
  expect(seen).toEqual(['effort']);
});
it('rejects a stale preview before changing the seat',async()=>{
  const f=fixture(); const p=await f.service.plan(f.rig.id,'dev.agent',{provider:'openai',account:'primary',model:'fixture-new',effort:null,mode:'save'});
  f.repo.setNodeModel(f.node.id,'fixture-other');
  await expect(f.service.apply(f.rig.id,'dev.agent',p.planId,true)).rejects.toThrow('settings_changed');
});
it('applies provider changes through a new-conversation handoff rather than rewriting the current runtime',async()=>{
  const f=fixture();const p=await f.service.plan(f.rig.id,'dev.agent',{provider:'claude',account:'personal',model:'sonnet',effort:'high',mode:'apply'});
  expect(p.newConversation).toBe(true);
  const op=await f.service.apply(f.rig.id,'dev.agent',p.planId,true);
  await vi.waitFor(()=>expect(f.service.operation(op.operationId).status).toBe('completed'));
  expect(f.handover).toHaveBeenCalledWith(expect.objectContaining({source:'rebuild',successorSettings:{runtime:'claude-code',model:'sonnet',effort:'high'}}));
});
it('refuses unsigned accounts, unsafe values and save-only provider changes',async()=>{
  const f=fixture();
  for(const input of [{provider:'openai',account:'missing',model:null,effort:null,mode:'apply'},{provider:'claude',account:'personal',model:null,effort:null,mode:'save'},{provider:'openai',account:'primary',model:'bad;command',effort:null,mode:'save'}]){
    await expect(f.service.plan(f.rig.id,'dev.agent',input)).rejects.toThrow();
  }
});
it('serves the dashboard preview and requires explicit confirmation over HTTP',async()=>{
  const f=fixture();const app=new Hono();app.route('/api/brain',brainSettingsRoutes(f.service));
  const base=`/api/brain/${f.rig.id}/dev.agent`;
  const response=await app.request(`${base}/plan`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({provider:'openai',account:'primary',model:null,effort:null,mode:'save'})});
  expect(response.status).toBe(200);
  const plan=await response.json();
  const refused=await app.request(`${base}/apply`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({planId:plan.planId})});
  expect(refused.status).toBe(409);expect(await refused.json()).toEqual({error:'confirmation_required'});
  const accepted=await app.request(`${base}/apply`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({planId:plan.planId,acknowledge:true})});
  expect(accepted.status).toBe(202);
  const remote=await app.request(`${base}?host=other-host`);expect(remote.status).toBe(409);
});
