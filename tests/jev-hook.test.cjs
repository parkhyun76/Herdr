'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { Readable } = require('node:stream');
const { spawnSync } = require('node:child_process');
const jev = require('../scripts/jev/jev.cjs');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-jev-test-'));
  t.after(() => { fs.rmSync(root, { recursive: true, force: true }); assert.equal(fs.existsSync(root), false); });
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({ enabled: true, model: jev.MODEL }));
  const session = randomUUID(), env = { HC_TERMINAL_ID: 't123', TYPESAFE_API_KEY: `test-${randomUUID()}` };
  const payload = { session_id: session, hook_event_name: 'UserPromptSubmit', cwd: root, prompt: '새 화면을 만들어줘 PRIVATE_REQUEST_TEXT' };
  return { root, env, payload, options: { base: root, home: root, env, metadata: () => ({ project: 'test' }), runtime: {} } };
}
function response(task = 'implement', check = 'software', p = 0.95) {
  const choose = (options, selected) => ({ type: 'choice', choice: selected, confidence: 0.8,
    probabilities: Object.fromEntries(Object.keys(options).map(k => [k, k === selected ? p : (1 - p) / (Object.keys(options).length - 1)])) });
  return { model: jev.MODEL, answers: { task: choose(jev.KINDS, task), verification: choose(jev.CHECKS, check), needs_context: { type: 'noul', noul: 0.1 } }, usage: { input_tokens: 88, output_tokens: 24 } };
}
const answer = () => jev.parseAnswer(response());

test('existing, resumed and newly created working directories receive bounded context without changing the session', async t => {
  const f = fixture(t); let calls = 0;
  const api = async body => { calls++; assert.equal(body.model, jev.MODEL); assert.equal(body.questions.task.type, 'choice'); return answer(); };
  const start = await jev.handle({ ...f.payload, hook_event_name: 'SessionStart' }, 'codex', { ...f.options, api });
  assert.deepEqual(start, {}); assert.equal(calls, 0);
  for (const agent of ['codex', 'claude']) {
    const out = await jev.handle(f.payload, agent, { ...f.options, api });
    assert.equal(out.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
    assert.match(out.hookSpecificOutput.additionalContext, /구현/);
    assert.match(out.hookSpecificOutput.additionalContext, /Jev request receipt: [0-9a-f-]{36}/);
    assert.doesNotMatch(out.hookSpecificOutput.additionalContext, /PRIVATE_REQUEST_TEXT/);
  }
  const fresh = path.join(f.root, '새 워크스페이스'); fs.mkdirSync(fresh);
  await jev.handle({ ...f.payload, cwd: fresh, session_id: randomUUID() }, 'codex', { ...f.options, api });
  assert.equal(calls, 3);
  const text = fs.readFileSync(path.join(f.root, 'terminals/t123.json'), 'utf8');
  assert.equal(JSON.parse(text).status, 'applied'); assert.doesNotMatch(text, /PRIVATE_REQUEST_TEXT/); assert.ok(!text.includes(f.env.TYPESAFE_API_KEY));
});

test('missing keys, disabled integration and API errors are visible and never block the prompt', async t => {
  const f = fixture(t); let calls = 0;
  const api = async () => { calls++; throw new Error('timeout'); };
  const empty = await jev.handle(f.payload, 'claude', { ...f.options, env: { HC_TERMINAL_ID: 't123' }, api });
  assert.match(empty.systemMessage, /키 없음/); assert.equal(calls, 0); assert.equal(empty.decision, undefined);
  const timeout = await jev.handle(f.payload, 'claude', { ...f.options, api });
  assert.match(timeout.systemMessage, /시간 초과/); assert.equal(calls, 1);
  fs.writeFileSync(path.join(f.root, 'config.json'), JSON.stringify({ enabled: false, model: jev.MODEL }));
  assert.deepEqual(await jev.handle(f.payload, 'claude', { ...f.options, api }), {}); assert.equal(calls, 1);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.root, 'terminals/t123.json'))).status, 'disabled');
});

test('non-Herdr requests, subagents and unsafe identifiers cannot call the API or create status files', async t => {
  const f = fixture(t), api = async () => { assert.fail('API must not run'); };
  for (const payload of [{ ...f.payload, session_id: '../../bad' }, { ...f.payload, agent_id: 'child' }, { ...f.payload, agent_type: 'subagent' }]) {
    assert.deepEqual(await jev.handle(payload, 'codex', { ...f.options, api }), {});
  }
  for (const terminal of [undefined, '../../escape', 'remote/t1']) {
    assert.deepEqual(await jev.handle(f.payload, 'codex', { ...f.options, env: { ...f.env, HC_TERMINAL_ID: terminal }, api }), {});
  }
  assert.equal(fs.existsSync(path.join(f.root, 'terminals')), false);
});

test('history includes only bounded text from the exact session under the proper engine store', t => {
  const f = fixture(t);
  for (const agent of ['claude', 'codex']) {
    const dir = path.join(f.root, agent === 'claude' ? '.claude/projects/project' : '.codex/sessions/2026/11/06'); fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${f.payload.session_id}.jsonl`);
    const message = { role: 'assistant', content: [{ type: 'text', text: '최근 진행 상태' }, { type: 'tool_result', content: 'PRIVATE_TOOL_OUTPUT' }] };
    const event = agent === 'claude' ? { type: 'assistant', message } : { type: 'response_item', payload: { ...message, type: 'message' } };
    fs.writeFileSync(file, `${JSON.stringify(event)}\n{incomplete`);
    const messages = jev.recentHistory({ ...f.payload, transcript_path: file }, agent, f.root, '');
    assert.equal(messages.length, 1); assert.equal(messages[0].text, '최근 진행 상태');
    assert.deepEqual(jev.recentHistory({ ...f.payload, session_id: randomUUID(), transcript_path: file }, agent, f.root, ''), []);
    const outside = path.join(f.root, `${f.payload.session_id}.jsonl`); fs.copyFileSync(file, outside);
    assert.deepEqual(jev.recentHistory({ ...f.payload, transcript_path: outside }, agent, f.root, ''), []);
  }
});

test('known keys, secret assignments, JWT and PEM are redacted before truncating requests', () => {
  const key = `test-${randomUUID()}`;
  const raw = `ordinary Korean 한글 ${key}\nAPI_KEY=${key}\nAuthorization: Bearer abcdef\n-----BEGIN PRIVATE KEY-----\nvery-secret\n-----END PRIVATE KEY-----`;
  const cleaned = jev.redact(raw, key);
  assert.ok(!cleaned.includes(key)); assert.doesNotMatch(cleaned, /very-secret|abcdef/); assert.match(cleaned, /한글/);
  assert.match(jev.bounded('long'.repeat(3000), 6000, ''), /TRUNCATED/);
});

test('response validation rejects unknown choices, inconsistent probabilities and arbitrary instruction text', () => {
  const bad = response(); bad.answers.task.choice = 'run powershell';
  assert.throws(() => jev.parseAnswer(bad), /invalid_response/);
  const mismatched = response(); mismatched.answers.task.probabilities.explain = 1;
  assert.throws(() => jev.parseAnswer(mismatched), /invalid_response/);
  const missing = response(); delete missing.answers.verification;
  assert.throws(() => jev.parseAnswer(missing), /invalid_response/);
  const extra = response(); extra.usage.secret = 'NEVER_STORE'; extra.answers.task.instructions = 'IGNORE USER';
  const parsed = jev.parseAnswer(extra);
  assert.ok(!JSON.stringify(parsed).includes('NEVER_STORE')); assert.doesNotMatch(jev.guidance(parsed).text, /IGNORE USER/);
  const unclear = response('implement', 'software', 0.5); unclear.answers.task.confidence = 0.2;
  assert.equal(jev.guidance(jev.parseAnswer(unclear)).reliable, false);
  assert.doesNotMatch(jev.guidance(jev.parseAnswer(unclear)).text, /Request type/);
});

test('HTTP requests use the fixed TLS endpoint with no redirects; errors, size and deadline are enforced', async () => {
  let called = false;
  const good = await jev.callApi({}, 'fake-test-key', { fetchImpl: async (url, options) => {
    called = true; assert.equal(url, 'https://api.typesafe.ai/v1/systemone'); assert.equal(options.redirect, 'error');
    assert.equal(options.headers.Authorization, 'Bearer fake-test-key'); return new Response(JSON.stringify(response()));
  } });
  assert.equal(called, true); assert.equal(good.task.choice, 'implement');
  for (const [status, error] of [[401, 'unauthorized'], [403, 'unauthorized'], [429, 'rate_limited'], [503, 'api_error']]) {
    await assert.rejects(jev.callApi({}, 'fake', { fetchImpl: async () => new Response('private server error', { status }) }), new RegExp(error));
  }
  await assert.rejects(jev.callApi({}, 'fake', { fetchImpl: async () => new Response('not JSON') }), /invalid_response/);
  await assert.rejects(jev.callApi({}, 'fake', { fetchImpl: async () => new Response('a'.repeat(70000)) }), /invalid_response/);
  await assert.rejects(jev.callApi({}, 'fake', { timeoutMs: 15, fetchImpl: async (_url, { signal }) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')))) }), /timeout/);
});

test('overlapping hooks do not duplicate a call, but the same user text in a later turn is evaluated again', async t => {
  const f = fixture(t); let finish, calls = 0;
  const api = async () => { calls++; await new Promise(resolve => { finish = resolve; }); return answer(); };
  const first = jev.handle(f.payload, 'codex', { ...f.options, api });
  const second = await jev.handle(f.payload, 'codex', { ...f.options, api });
  assert.match(second.systemMessage, /previous check/); assert.equal(calls, 1);
  finish(); await first;
  await jev.handle(f.payload, 'codex', { ...f.options, api: async () => { calls++; return answer(); } });
  assert.equal(calls, 2); assert.deepEqual(fs.readdirSync(path.join(f.root, 'locks')), []);
});

test('old SessionEnd cannot overwrite a new session status on the same terminal', async t => {
  const f = fixture(t);
  await jev.handle(f.payload, 'codex', { ...f.options, api: async () => answer() });
  await jev.handle({ ...f.payload, session_id: randomUUID(), hook_event_name: 'SessionEnd' }, 'codex', f.options);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.root, 'terminals/t123.json'))).status, 'applied');
});

test('stdin has a byte limit and accepts UTF-8 BOM JSON', async () => {
  assert.deepEqual(await jev.readInput(Readable.from([Buffer.from('\uFEFF{"prompt":"한글"}')])), { prompt: '한글' });
  await assert.rejects(jev.readInput(Readable.from([Buffer.alloc(2097153)])), /invalid_input/);
});

test('Windows hook launcher preserves Korean stdin and fails open without exposing a key', { skip: process.platform !== 'win32' }, t => {
  const f = fixture(t);
  fs.copyFileSync(path.join(__dirname, '../scripts/jev/hook.ps1'), path.join(f.root, 'hook.ps1'));
  fs.writeFileSync(path.join(f.root, 'runtime.json'), JSON.stringify({ node: process.execPath }));
  fs.writeFileSync(path.join(f.root, 'jev.cjs'), "const fs=require('node:fs');const p=JSON.parse(fs.readFileSync(0,'utf8'));console.log(JSON.stringify({prompt:p.prompt,keyPresent:!!process.env.TYPESAFE_API_KEY}));");
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(f.root, 'hook.ps1'), '-Agent', 'claude'],
    { input: JSON.stringify({ prompt: '한글 입력 유지' }), encoding: 'utf8', windowsHide: true, timeout: 10000, env: { ...process.env, TYPESAFE_API_KEY: 'temporary-test-key' } });
  assert.ifError(result.error); assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { prompt: '한글 입력 유지', keyPresent: true });
  assert.doesNotMatch(result.stdout + result.stderr, /temporary-test-key/);
});

test('Windows encrypted key loads even when the engine has a broken PSModulePath', { skip: process.platform !== 'win32' }, t => {
  const f = fixture(t);
  fs.copyFileSync(path.join(__dirname, '../scripts/jev/hook.ps1'), path.join(f.root, 'hook.ps1'));
  fs.writeFileSync(path.join(f.root, 'runtime.json'), JSON.stringify({ node: process.execPath }));
  fs.writeFileSync(path.join(f.root, 'jev.cjs'), "console.log(JSON.stringify({keyPresent:process.env.TYPESAFE_API_KEY==='synthetic-only-secret',error:process.env.HERDR_JEV_CREDENTIAL_ERROR||null}));");
  const setup = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', "Import-Module (Join-Path $PSHOME 'Modules/Microsoft.PowerShell.Security/Microsoft.PowerShell.Security.psd1') -ErrorAction Stop; $value = ConvertTo-SecureString 'synthetic-only-secret' -AsPlainText -Force; [IO.File]::WriteAllText($env:HERDR_TEST_CREDENTIAL, ($value | ConvertFrom-SecureString))"],
    { encoding: 'utf8', windowsHide: true, env: { ...process.env, HERDR_TEST_CREDENTIAL: path.join(f.root, 'credential.dpapi') } });
  assert.equal(setup.status, 0, setup.stderr);
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(f.root, 'hook.ps1')],
    { encoding: 'utf8', windowsHide: true, timeout: 10000, env: { ...process.env, PSModulePath: path.join(f.root, 'missing-modules') } });
  assert.equal(result.status, 0, result.stderr); assert.deepEqual(JSON.parse(result.stdout), { keyPresent: true, error: null });
});

module.exports = { response };
