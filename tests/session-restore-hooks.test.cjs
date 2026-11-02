'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { spawnSync } = require('node:child_process');

test('identity hook stores metadata only, rejects invalid/sub-agent IDs, and records normal exit', {skip:process.platform!=='win32'||process.env.HERDR_HOOK_INTEGRATION_TEST!=='1'}, () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(),'herdr-hook-test-'));
  const hook = path.resolve(__dirname,'../native/herdr-app/src/session_restore/hook.ps1');
  const sid = randomUUID();
  const file = path.join(base,'Herdr/session-restore/links',`codex-${sid}.json`);
  const payload = {session_id:sid,hook_event_name:'SessionStart',cwd:base,transcript_path:path.join(base,`${sid}.jsonl`),prompt:'PRIVATE_TEST_TEXT_NOT_TO_STORE'};
  const invoke = value => {
    const result=spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',hook,'-Agent','codex'],{
      env:{...process.env,LOCALAPPDATA:base,HC_TERMINAL_ID:'hook-test-terminal'},input:JSON.stringify(value),encoding:'utf8',windowsHide:true,timeout:10000,
    });
    assert.ifError(result.error); assert.equal(result.status,0,result.stderr); assert.equal(result.stderr,'');
  };
  try {
    invoke({...payload,session_id:'../../invalid'});
    invoke({...payload,agent_id:'sub-agent'});
    assert.equal(fs.existsSync(file),false);
    invoke(payload);
    assert.equal(fs.existsSync(file),true,'Run this identity test from a Codex-owned development session');
    let text=fs.readFileSync(file,'utf8'); const record=JSON.parse(text);
    assert.equal(record.session_id,sid); assert.equal(record.ended,false);
    assert.ok(record.lineage.length>0); assert.equal(text.includes(payload.prompt),false);
    assert.equal(record.terminal_id,'hook-test-terminal');
    invoke({...payload,hook_event_name:'UserPromptSubmit'});
    const refreshed=JSON.parse(fs.readFileSync(file,'utf8'));
    assert.equal(refreshed.pid,record.pid); assert.deepEqual(refreshed.lineage,record.lineage);
    invoke({...payload,hook_event_name:'SessionEnd',reason:'other'});
    assert.equal(JSON.parse(fs.readFileSync(file,'utf8')).ended,true);
  } finally { fs.rmSync(base,{recursive:true,force:true}); }
});
