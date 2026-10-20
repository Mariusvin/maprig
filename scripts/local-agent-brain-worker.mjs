import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import * as store from './local-agent-account-store.mjs';
import { localRig, switchLocalAccount } from './local-agent-accounts.mjs';

const providers=[{id:'openai',label:'OpenAI',runtime:'codex',efforts:['low','medium','high','xhigh']},{id:'claude',label:'Claude',runtime:'claude-code',efforts:['low','medium','high','max']}];
function models(provider){
  if(provider==='claude')return [{id:'sonnet',label:'Sonnet'},{id:'opus',label:'Opus'},{id:'haiku',label:'Haiku'}];
  const file=path.join(process.env.CODEX_HOME||path.join(process.env.HOME||os.homedir(),'.codex'),'models_cache.json');
  try{
    if(fs.statSync(file).size>2*1024*1024)return [];
    const data=JSON.parse(fs.readFileSync(file,'utf8'));
    return (Array.isArray(data.models)?data.models:[]).filter(m=>typeof m.slug==='string'&&/^[a-zA-Z0-9][a-zA-Z0-9_.:/-]{0,127}$/.test(m.slug)&&m.visibility!=='hide')
      .map(m=>({id:m.slug,label:typeof m.display_name==='string'?m.display_name.slice(0,100):m.slug}));
  }catch{return [];}
}
try{
  let input='';for await(const chunk of process.stdin){input+=chunk;if(input.length>65536)throw Error('invalid_worker_input');}
  const {action,options={}}=JSON.parse(input);
  let result;
  if(action==='status')result={providers:providers.map(p=>{
    try{const status=store.accountStatus(p.id);return {...p,available:status.accounts.some(a=>a.loginPresent),activeAccount:status.active,accounts:status.accounts,models:models(p.id),...(status.recoveryRequired?{available:false,issue:'An interrupted switch needs recovery.'}:{})};}
    catch{return {...p,available:false,activeAccount:'',accounts:[],models:[],issue:'Saved accounts could not be read.'};}
  })};
  else if(action==='inventory')result=localRig(['ps','--nodes','-A','--json']);
  else if(['plan','switch'].includes(action))result=await switchLocalAccount({...options,plan:action==='plan'},{store:async(method,args)=>store[method](...args),rig:async args=>localRig(args)});
  else throw Error('invalid_worker_action');
  console.log(JSON.stringify(result));
}catch(error){console.log(JSON.stringify({error:/^[a-z_]+$/.test(error.message)?error.message:'brain_worker_failed'}));process.exitCode=1;}
