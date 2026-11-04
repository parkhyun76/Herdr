'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const helper = path.resolve(__dirname, '../mods/files-utf8/list-windows.ps1');
function list(folder, home) {
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-File', helper,
    '-Folder', folder, '-AppHome', home], { encoding: 'utf8', windowsHide: true, timeout: 60000 });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  return JSON.parse(result.stdout);
}
function png(home, asset) {
  assert.match(asset, /^data\/files-utf8\/windows-icons-v1\/[a-f0-9]{64}\.png$/);
  const bytes = fs.readFileSync(path.join(home, asset));
  assert.deepEqual([...bytes.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  assert.ok(bytes.readUInt32BE(16) >= 16);
  assert.ok(bytes.readUInt32BE(20) >= 16);
  return bytes;
}

test('Windows Shell icons: Unicode paths, file associations, folders, executables and warm cache',
  { skip: process.platform !== 'win32' }, () => {
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-icons-'));
    try {
      const folder = path.join(temporary, "한글 ' $파일"), home = path.join(temporary, 'app');
      fs.mkdirSync(folder);
      for (const name of ['문서.txt', 'UPPER.TXT', '사진.png', '회의.xlsx', '설명.pdf', 'unknown.herdr_unknown_type', 'LICENSE'])
        fs.writeFileSync(path.join(folder, name), 'fixture');
      fs.mkdirSync(path.join(folder, '폴더'));
      fs.mkdirSync(path.join(folder, '.git'));
      fs.copyFileSync(path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'), path.join(folder, 'shell.exe'));
      const before = fs.readdirSync(folder);
      const entries = list(folder, home), byName = Object.fromEntries(entries.map(entry => [entry.name, entry]));
      assert.equal(entries.length, 9);
      assert.equal(byName['.git'], undefined);
      for (const entry of entries) {
        assert.equal(entry.iconError, undefined, `${entry.name}: ${entry.iconError}`);
        png(home, entry.icon);
      }
      assert.equal(byName['문서.txt'].icon, byName['UPPER.TXT'].icon);
      assert.equal(byName['폴더'].dir, true);
      png(home, byName['폴더'].openIcon);
      assert.notEqual(byName['shell.exe'].icon, byName['unknown.herdr_unknown_type'].icon);
      assert.notEqual(byName['폴더'].icon, byName['unknown.herdr_unknown_type'].icon);
      assert.deepEqual(fs.readdirSync(folder), before, 'No metadata/cache files in the browsed folder');
      const cache = path.join(home, 'data/files-utf8/windows-icons-v1');
      const cached = fs.readdirSync(cache).sort();
      assert.deepEqual(list(folder, home), entries);
      assert.deepEqual(fs.readdirSync(cache).sort(), cached, 'No duplicate cache assets on refresh');
      const blockedHome = path.join(temporary, 'blocked-app');
      fs.mkdirSync(blockedHome);
      fs.writeFileSync(path.join(blockedHome, 'data'), 'not a directory');
      const fallback = list(folder, blockedHome);
      assert.equal(fallback.length, entries.length, 'Icon cache failure must not hide the file list');
      assert.ok(fallback.every(entry => entry.iconError && !entry.icon));
    } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
  });

test('Windows listing keeps the lazy-browser limit and reports unreadable folders',
  { skip: process.platform !== 'win32' }, () => {
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-icons-limit-'));
    try {
      const folder = path.join(temporary, 'files'), home = path.join(temporary, 'app');
      fs.mkdirSync(folder);
      assert.deepEqual(list(folder, home), []);
      for (let i = 0; i < 505; i++) fs.writeFileSync(path.join(folder, `${i}.txt`), '');
      assert.equal(list(folder, home).length, 501);
      const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-File', helper,
        '-Folder', path.join(temporary, 'missing'), '-AppHome', home], { encoding: 'utf8', windowsHide: true });
      assert.notEqual(result.status, 0);
      assert.ok(result.stderr);
    } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
  });

test('Windows lists OneDrive cloud folders as directories while keeping junctions unexpanded',
  { skip: process.platform !== 'win32' }, (t) => {
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-cloud-folder-'));
    const link = path.join(temporary, 'cycle');
    try {
      fs.symlinkSync(temporary, link, 'junction');
      const entry = list(temporary, path.join(temporary, 'app')).find(item => item.name === 'cycle');
      assert.equal(entry.dir, false, 'junction to an ancestor is not traversed');
      fs.unlinkSync(link);
      const parent = 'D:/OneDrive/Work/연구개발/제품개발';
      if (!fs.existsSync(path.join(parent, 'PHM-VB-BT'))) return t.diagnostic('OneDrive project folder unavailable; fixture check completed');
      const cloud = list(parent, path.join(temporary, 'app')).find(item => item.name === 'PHM-VB-BT');
      assert.ok(cloud, 'existing project folder is listed');
      assert.equal(cloud.dir, true, 'cloud reparse directory must expand as a folder');
      assert.ok(Array.isArray(list(path.join(parent, 'PHM-VB-BT'), path.join(temporary, 'app'))));
    } finally {
      if (fs.existsSync(link)) fs.unlinkSync(link);
      fs.rmSync(temporary, { recursive: true, force: true });
    }
    assert.equal(fs.existsSync(temporary), false);
  });
