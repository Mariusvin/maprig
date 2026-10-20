import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

test('the dashboard account read exposes labels and cached models without login material',t=>{
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'brain-worker-'));
  t.after(()=>fs.rmSync(home,{recursive:true,force:true}));
  const native=path.join(home,'.codex');fs.mkdirSync(native);
  fs.writeFileSync(path.join(native,'auth.json'),'fixture-secret-never-print');
  fs.writeFileSync(path.join(native,'models_cache.json'),JSON.stringify({models:[{slug:'fixture-model',display_name:'Fixture model'},{slug:'bad;command',display_name:'Invalid'}]}));
  const result=spawnSync(process.execPath,[fileURLToPath(new URL('./local-agent-brain-worker.mjs',import.meta.url))],{
    env:{...process.env,HOME:home,CODEX_HOME:native,CLAUDE_CONFIG_DIR:path.join(home,'.claude'),OPENRIG_HOME:path.join(home,'.openrig')},
    input:JSON.stringify({action:'status'}),encoding:'utf8',timeout:5000,
  });
  assert.equal(result.status,0,result.stderr);
  assert(!result.stdout.includes('fixture-secret-never-print'));
  assert(!result.stdout.includes(native.replaceAll('\\','\\\\')));
  const data=JSON.parse(result.stdout);
  assert.deepEqual(data.providers[0].models,[{id:'fixture-model',label:'Fixture model'}]);
  assert.equal(data.providers[0].accounts[0].loginPresent,true);
  assert.equal(data.providers[1].available,false);
});
