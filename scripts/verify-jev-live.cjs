'use strict';
// Explicit, synthetic engine smoke test. No prompt is sent to an existing conversation.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { findCodex } = require('./install-jev.cjs');
const { LABELS, redact } = require('./jev/jev.cjs');

async function check(agent, executable, args, root, base) {
  const terminal = `tjev${randomUUID().replaceAll('-', '').slice(0, 12)}`;
  const file = path.join(base, 'terminals', `${terminal}.json`);
  const env = { ...process.env, HC_TERMINAL_ID: terminal };
  delete env.CODEX_TITLE_FILE; delete env.CLAUDECODE;
  let receipt, output = '', errors = '', timedOut = false;
  const observations = [], engineErrors = [];
  const child = spawn(executable, args, { cwd: root, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', data => { if (output.length < 1048576) output += data; });
  child.stderr.on('data', data => { if (errors.length < 65536) errors += data; });
  const observe = () => {
    try {
      const current = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (observations.at(-1) !== current.status) observations.push(current.status);
      if (['applied', 'uncertain'].includes(current.status)) receipt = current;
    } catch {}
  };
  const timer = setInterval(observe, 50);
  const deadline = setTimeout(() => { timedOut = true; child.kill(); }, 90000);
  let code;
  try {
    code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
    observe();
    const markers = [];
    for (const line of output.split('\n')) {
      let event; try { event = JSON.parse(line); } catch { continue; }
      if (event.is_error || event.type === 'error') engineErrors.push({ status: event.api_error_status, code: event.api_error, message: redact(event.result ?? event.message ?? '').slice(0, 300) });
      const text = event.result ?? event.item?.text ?? '';
      if (typeof text === 'string') markers.push(...(text.match(/JEV_(?:RECEIPT=[0-9a-f-]{36}|MISSING)/gi) ?? []));
    }
    const expected = LABELS[receipt?.task?.choice];
    return { agent, exit: code, timedOut, hookObserved: Boolean(receipt), model: receipt?.model,
      category: expected, modelSawContext: Boolean(receipt?.request_id && markers.some(m => m === `JEV_RECEIPT=${receipt.request_id}`)),
      markers: markers.map(m => m.slice(0, 100)), stderr: redact(errors).slice(0, 2000), engineErrors, observations,
      hookHealth: (() => { try { return JSON.parse(fs.readFileSync(path.join(base, 'health', `${agent}.json`), 'utf8')); } catch { return null; } })(),
      status: receipt?.status ?? (() => { try { return JSON.parse(fs.readFileSync(file, 'utf8')).status; } catch { return 'unconfirmed'; } })() };
  } finally {
    clearInterval(timer); clearTimeout(deadline);
    // UUIDs/terminal names belong exclusively to this test. Do not touch existing histories.
    let record; try { record = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
    if (record?.terminal === terminal) {
      fs.unlinkSync(file);
      if (/^[0-9a-f-]{36}$/i.test(record.session_id)) {
        const link = path.join(process.env.LOCALAPPDATA, 'Herdr/session-restore/links', `${agent}-${record.session_id}.json`);
        try {
          const saved = JSON.parse(fs.readFileSync(link, 'utf8'));
          if (saved.terminal_id === terminal) { fs.unlinkSync(link); if (fs.existsSync(`${link}.lock`)) fs.unlinkSync(`${link}.lock`); }
        } catch {}
      }
    }
    const lock = path.join(base, 'locks', `${terminal}.lock`);
    if (fs.existsSync(lock)) fs.unlinkSync(lock);
  }
}
async function main() {
  const home = os.homedir(), base = path.join(process.env.LOCALAPPDATA, 'Herdr/jev');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-jev-live-'));
  const prompt = 'This is a synthetic integration check. Read the supplementary Herdr Jev advisory supplied for this request. Reply with exactly JEV_RECEIPT= followed by the UUID after "Jev request receipt:" in that advisory. If there is no such receipt, reply JEV_MISSING. Do not call tools, read files, or change anything.';
  try {
    const claude = path.join(home, 'AppData/Roaming/npm/node_modules/@anthropic-ai/claude-code/bin/claude.exe');
    const results = [];
    const selected = process.argv.includes('--codex-only') ? ['codex'] : ['claude', 'codex'];
    if (selected.includes('claude')) {
      results.push(await check('claude', claude, ['-p', '--output-format', 'json', '--tools', '', '--no-session-persistence', '--session-id', randomUUID(), prompt], root, base));
      console.log(JSON.stringify(results.at(-1)));
    }
    if (selected.includes('codex')) {
      results.push(await check('codex', findCodex(home), ['exec', '--ephemeral', '--skip-git-repo-check', '--sandbox', 'read-only', '--json', prompt], root, base));
      console.log(JSON.stringify(results.at(-1)));
    }
    if (results.some(r => r.exit !== 0 || !r.hookObserved || !r.modelSawContext)) process.exitCode = 1;
  } finally {
    const resolved = fs.realpathSync(root), temporary = fs.realpathSync(os.tmpdir());
    if (!path.relative(temporary, resolved).startsWith('herdr-jev-live-')) throw new Error('Unexpected test scratch path; cleanup refused');
    fs.rmSync(resolved, { recursive: true, force: true });
    console.log(JSON.stringify({ scratchRemoved: !fs.existsSync(root) }));
  }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
