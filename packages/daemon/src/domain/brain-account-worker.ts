import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Account I/O and synchronous native CLI calls run outside the daemon event
// loop. Login bytes never cross this public JSON boundary.
export function runBrainAccountWorker(action:string, options:Record<string,unknown>={}) :Promise<any>{
  return new Promise((resolve,reject)=>{
    const script=fileURLToPath(new URL('../../assets/local-agents/local-agent-brain-worker.mjs',import.meta.url));
    const child=spawn(process.execPath,[script],{stdio:['pipe','pipe','ignore'],windowsHide:true});
    let output='',settled=false;
    const finish=(error?:Error,value?:unknown)=>{if(settled)return;settled=true;clearTimeout(timer);if(error)reject(error);else resolve(value);};
    const timer=setTimeout(()=>{child.kill();finish(Error('operation_outcome_unknown'));},action==='switch'?600_000:45_000);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data',chunk=>{output+=chunk;if(output.length>4*1024*1024){child.kill();finish(Error('operation_response_unreadable'));}});
    child.stdin.on('error',()=>finish(Error('brain_worker_unavailable')));
    child.on('error',()=>finish(Error('brain_worker_unavailable')));
    child.on('close',code=>{
      try{const result=JSON.parse(output);if(code!==0)finish(Error(/^[a-z_]+$/.test(result.error)?result.error:'brain_worker_failed'));else finish(undefined,result);}
      catch{finish(Error('operation_response_unreadable'));}
    });
    child.stdin.end(JSON.stringify({action,options}));
  });
}
