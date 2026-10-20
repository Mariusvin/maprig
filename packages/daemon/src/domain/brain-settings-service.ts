import { createHash, randomUUID } from 'node:crypto';
import type { RigRepository } from './rig-repository.js';
import type { EventBus } from './event-bus.js';
import type { SeatLifecycleService } from './seat-lifecycle-service.js';
import type { SeatHandoverService } from './seat-handover-service.js';
import type { CurrentModelReader } from './model-divergence/current-model-reader.js';
import { NativePermissionStore } from './native-permission-store.js';

type Provider = 'openai' | 'claude';
type Selection = { provider: Provider; account: string; model: string | null; effort: string | null; mode: 'save' | 'apply' };
interface Row { id: string; rig_id: string; rig_name: string; logical_id: string; runtime: string; model: string | null; effort: string | null; effort_choice: string | null }
interface Account { name: string; active: boolean; loginPresent: boolean }
export interface BrainProvider { id: Provider; label: string; runtime: string; available: boolean; activeAccount: string; accounts: Account[]; models: {id:string;label:string}[]; efforts: string[]; issue?: string }
interface Inventory {rigId:string;rigName:string;logicalId:string;canonicalSessionName:string;runtime:string;sessionStatus:string;resumeTokenPresent:boolean;agentActivity?:{state:string}}
interface Preview {planId:string;expiresAt:string;affectedSeats:string[];sharedAccount:boolean;providerChange:boolean;newConversation:boolean;summary:string}
interface StoredPlan {preview:Preview;row:Row;selection:Selection;signature:string}
interface Operation {operationId:string;status:'running'|'completed'|'incomplete'|'failed';phase:string;message?:string;error?:string}
interface Deps {
  rigRepo: RigRepository; eventBus: EventBus; lifecycle: Pick<SeatLifecycleService,'effortReport'>;
  handover: () => Pick<SeatHandoverService,'handover'>;
  worker: (action:string, input?: Record<string,unknown>) => Promise<any>;
  modelReader?: CurrentModelReader;
}
const runtimes = {openai:'codex',claude:'claude-code'} as const;
const live = (n:Inventory) => ['running','idle','unknown'].includes(n.sessionStatus);
const digest=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
export class BrainSettingsService {
  private plans=new Map<string,StoredPlan>();
  private operations=new Map<string,Operation>();
  private busy=false;
  constructor(private deps:Deps){}
  private row(rigId:string,logicalId:string):Row {
    const row=this.deps.rigRepo.db.prepare('SELECT n.id,n.rig_id,r.name rig_name,n.logical_id,n.runtime,n.model,n.effort,n.effort_choice FROM nodes n JOIN rigs r ON r.id=n.rig_id WHERE n.rig_id=? AND n.logical_id=?').get(rigId,logicalId) as Row|undefined;
    if(!row)throw Error('seat_not_found');
    if(!Object.values(runtimes).includes(row.runtime as any))throw Error('unsupported_seat_runtime');
    return row;
  }
  private session(row:Row) {
    return this.deps.rigRepo.db.prepare("SELECT id,session_name,status FROM sessions WHERE node_id=? AND status NOT IN ('superseded','exited') ORDER BY id DESC LIMIT 1").get(row.id) as {id:string;session_name:string;status:string}|undefined;
  }
  async status(rigId:string,logicalId:string) {
    const row=this.row(rigId,logicalId), session=this.session(row);
    const sessionName=session?.session_name ?? `${logicalId}@${row.rig_name}`;
    const {providers}=await this.deps.worker('status') as {providers:BrainProvider[]};
    const report=await this.deps.lifecycle.effortReport(sessionName);
    const observation=this.deps.modelReader ? (await this.deps.modelReader.observeInventory([{nodeId:row.id,canonicalSessionName:sessionName,runtime:row.runtime,sessionStatus:session?.status??null}]))[0] : null;
    return {seat:{rigId,logicalId,sessionName,runtime:row.runtime,model:row.model,effort:row.effort_choice??row.effort},
      running:{model:observation?.status==='observed'?observation.model:null,effort:report.ok&&report.observed.state==='observed'?report.observed.value:null},providers};
  }
  private selection(raw:unknown):Selection {
    const b=raw as Selection;
    if(!b||!Object.hasOwn(runtimes,b.provider)||!['save','apply'].includes(b.mode)
      ||typeof b.account!=='string'||!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,47}$/.test(b.account)
      ||(b.model!==null&&(typeof b.model!=='string'||!/^[a-zA-Z0-9][a-zA-Z0-9_.:/-]{0,127}$/.test(b.model)))
      ||(b.effort!==null&&(typeof b.effort!=='string'||!/^[a-z][a-z0-9_-]{0,31}$/.test(b.effort))))throw Error('invalid_brain_settings');
    return {provider:b.provider,account:b.account,model:b.model,effort:b.effort,mode:b.mode};
  }
  private async inspect(rigId:string,logicalId:string,raw:unknown) {
    const row=this.row(rigId,logicalId),selection=this.selection(raw),session=this.session(row);
    const {providers}=await this.deps.worker('status') as {providers:BrainProvider[]};
    const provider=providers.find(p=>p.id===selection.provider);
    if(!provider?.available||!provider.accounts.some(a=>a.name===selection.account&&a.loginPresent))throw Error('account_not_signed_in');
    if(selection.effort!==null&&!provider.efforts.includes(selection.effort))throw Error('unsupported_effort');
    const providerChange=row.runtime!==runtimes[selection.provider], sharedAccount=provider.activeAccount!==selection.account;
    if(selection.mode==='save'&&(providerChange||sharedAccount))throw Error('provider_or_account_requires_apply');
    let affectedSeats:string[]=[];
    let inventory:Inventory[]=[];
    if(selection.mode==='apply'){
      inventory=await this.deps.worker('inventory');
      if(!Array.isArray(inventory))throw Error('seat_inventory_unavailable');
      const target=inventory.find(n=>n.rigId===rigId&&n.logicalId===logicalId);
      if(!target||!live(target))throw Error('seat_must_be_running');
      if(!['idle','needs_input'].includes(target.agentActivity?.state??''))throw Error('seat_working_or_unknown');
      if(providerChange) new NativePermissionStore(this.deps.rigRepo.db).launchOverride(row.id,runtimes[selection.provider]);
      if(!providerChange||sharedAccount){
        const impact=await this.deps.worker('plan',{provider:selection.provider,account:selection.account,...(!providerChange?{resumeRig:rigId}:{})});
        affectedSeats=impact.affectedSeats??[];
      }
      if(providerChange)affectedSeats.push(target.canonicalSessionName);
    }
    affectedSeats=[...new Set(affectedSeats)].sort();
    const signature=digest({row,session,accounts:providers.map(p=>({id:p.id,active:p.activeAccount})),inventory:inventory.filter(n=>affectedSeats.includes(n.canonicalSessionName)).map(n=>({rig:n.rigId,seat:n.logicalId,runtime:n.runtime,status:n.sessionStatus})),affectedSeats});
    return {row,selection,signature,providerChange,sharedAccount,affectedSeats};
  }
  async plan(rigId:string,logicalId:string,raw:unknown):Promise<Preview>{
    if(this.busy)throw Error('brain_operation_in_progress');
    for(const [id,p]of this.plans)if(Date.parse(p.preview.expiresAt)<Date.now())this.plans.delete(id);
    if(this.plans.size>=100)this.plans.delete(this.plans.keys().next().value!);
    const state=await this.inspect(rigId,logicalId,raw);
    const preview={planId:randomUUID(),expiresAt:new Date(Date.now()+120_000).toISOString(),affectedSeats:state.affectedSeats,sharedAccount:state.sharedAccount,providerChange:state.providerChange,newConversation:state.providerChange,
      summary:state.selection.mode==='save'?'Save settings for the next managed resume. Running agents stay as they are.':state.providerChange?'Start a new conversation with the selected provider and hand over the seat\'s saved work.':'Snapshot affected rigs and resume their existing conversations with the selected settings.'};
    this.plans.set(preview.planId,{preview,row:state.row,selection:state.selection,signature:state.signature});
    return preview;
  }
  async apply(rigId:string,logicalId:string,planId:string,acknowledge:boolean){
    if(!acknowledge)throw Error('confirmation_required');
    const plan=this.plans.get(planId);
    if(!plan||Date.parse(plan.preview.expiresAt)<Date.now()||plan.row.rig_id!==rigId||plan.row.logical_id!==logicalId)throw Error('preview_expired');
    if(this.busy)throw Error('brain_operation_in_progress');
    this.busy=true;
    try{
      const current=await this.inspect(rigId,logicalId,plan.selection);
      if(current.signature!==plan.signature)throw Error('settings_changed');
      this.plans.delete(planId);
      const operation:Operation={operationId:randomUUID(),status:'running',phase:'preparing'};
      if(this.operations.size>=100)this.operations.delete(this.operations.keys().next().value!);
      this.operations.set(operation.operationId,operation);
      void this.execute(plan,operation).finally(()=>{this.busy=false;});
      return {operationId:operation.operationId};
    }catch(error){this.busy=false;throw error;}
  }
  operation(id:string):Operation{
    const op=this.operations.get(id);if(!op)throw Error('operation_not_found');return {...op};
  }
  private save(row:Row,selection:Selection){
    const notifications:ReturnType<EventBus['persistWithinTransaction']>[]=[];
    this.deps.rigRepo.db.transaction(()=>{
      this.deps.rigRepo.setNodeModel(row.id,selection.model);
      this.deps.rigRepo.setNodeEffortChoice(row.id,selection.effort);
      notifications.push(this.deps.eventBus.persistWithinTransaction({type:'node.model_changed',rigId:row.rig_id,nodeId:row.id,logicalId:row.logical_id,from:row.model,to:selection.model,reason:'Brain settings in dashboard',operator:'dashboard'}));
      notifications.push(this.deps.eventBus.persistWithinTransaction({type:'node.effort_changed',rigId:row.rig_id,nodeId:row.id,logicalId:row.logical_id,from:row.effort_choice,to:selection.effort,reason:'Brain settings in dashboard',operator:'dashboard'}));
    })();
    for(const event of notifications)this.deps.eventBus.notifySubscribers(event);
  }
  private async execute(plan:StoredPlan,op:Operation){
    const {row,selection:s}=plan;
    try{
      if(plan.preview.providerChange){
        if(plan.preview.sharedAccount){op.phase='switching account';const result=await this.deps.worker('switch',{provider:s.provider,account:s.account});if(!['resumed','unchanged'].includes(result.outcome))throw Error('account_switch_incomplete');}
        op.phase='handing over';
        const result=await this.deps.handover().handover({seatRef:this.session(row)?.session_name??`${row.logical_id}@${row.rig_name}`,source:'rebuild',reason:'Provider change in dashboard',operator:'dashboard',successorSettings:{runtime:runtimes[s.provider],model:s.model,effort:s.effort}});
        if(!result.ok)throw Error('provider_handoff_incomplete');
      }else{
        op.phase='saving settings';this.save(row,s);
        if(s.mode==='apply'){
          op.phase='resuming conversations';
          const result=await this.deps.worker('switch',{provider:s.provider,account:s.account,resumeRig:row.rig_id});
          if(result.outcome!=='resumed')throw Error('conversation_resume_incomplete');
        }
      }
      op.status='completed';op.phase='complete';op.message=s.mode==='save'?'Saved for the next resume. The running agent was not restarted.':plan.preview.providerChange?'Provider changed. A new conversation received the seat\'s saved handoff.':'Settings applied and existing conversations resumed.';
    }catch(error){op.status='incomplete';op.error=/^[a-z_]+$/.test((error as Error).message)?(error as Error).message:'brain_operation_incomplete';op.message='The operation did not complete. Inspect the agent and saved settings before retrying. No automatic retry was made.';}
  }
}
