import { Hono } from 'hono';
import type { RigRepository } from '../domain/rig-repository.js';
import type { EventBus } from '../domain/event-bus.js';
import type { CurrentModelReader } from '../domain/model-divergence/current-model-reader.js';
import { BrainSettingsService } from '../domain/brain-settings-service.js';
import { runBrainAccountWorker } from '../domain/brain-account-worker.js';
import { seatHandoverService, seatLifecycleService } from './seat.js';

export function brainSettingsRoutes(provided?:BrainSettingsService){
  const router=new Hono();
  let service:BrainSettingsService|undefined=provided;
  router.onError((error,c)=>{
    const code=/^[a-z_]+$/.test(error.message)?error.message:'brain_settings_unavailable';
    return c.json({error:code},code==='seat_not_found'||code==='operation_not_found'?404:409);
  });
  router.use('*',async(c,next)=>{
    // These controls operate this daemon's native homes, never a remote host.
    const host=c.req.query('host');
    if(host&&host!=='local')return c.json({error:'remote_brain_settings_read_only'},409);
    service??=new BrainSettingsService({rigRepo:c.get('rigRepo' as never) as RigRepository,eventBus:c.get('eventBus' as never) as EventBus,
      lifecycle:seatLifecycleService(c),handover:()=>seatHandoverService(c),worker:runBrainAccountWorker,
      modelReader:c.get('currentModelReader' as never) as CurrentModelReader|undefined});
    await next();
  });
  router.get('/operations/:id',c=>c.json(service!.operation(c.req.param('id'))));
  router.get('/:rigId/:logicalId',async c=>c.json(await service!.status(c.req.param('rigId'),c.req.param('logicalId'))));
  router.post('/:rigId/:logicalId/plan',async c=>c.json(await service!.plan(c.req.param('rigId'),c.req.param('logicalId'),await c.req.json())));
  router.post('/:rigId/:logicalId/apply',async c=>{
    const body=await c.req.json();
    if(!body||typeof body.planId!=='string')return c.json({error:'preview_required'},400);
    return c.json(await service!.apply(c.req.param('rigId'),c.req.param('logicalId'),body.planId,body.acknowledge===true),202);
  });
  return router;
}
