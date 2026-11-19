const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { Problem } = require('../backend');
const gitMod = require('../git');

function hasGit() { try { execFileSync('git', ['--version']); return true; } catch (e) { return false; } }
function repo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-git-'));
  const g = (...a) => execFileSync('git', a, { cwd: root, encoding: 'utf8' });
  g('init', '-q'); g('config', 'user.name', 'T'); g('config', 'user.email', 't@t');
  for (const f of ['a.txt', 'b.txt', 'gone.txt']) fs.writeFileSync(path.join(root, f), f + ' v1\n');
  g('add', '-A'); g('commit', '-q', '-m', 'first');
  const api = gitMod.create({ check: p => path.resolve(p), root: () => root, Problem });
  return { root, g, api };
}

test('commit takes exactly the ticked files and leaves terminal-staged work staged (audit issue 5)', { skip: process.platform === 'win32' || !hasGit() }, async () => {
  const r = repo();
  fs.writeFileSync(path.join(r.root, 'a.txt'), 'a v2\n');           // ticked
  fs.writeFileSync(path.join(r.root, 'b.txt'), 'b v2\n'); r.g('add', 'b.txt');   // staged in a terminal, not ticked
  fs.writeFileSync(path.join(r.root, 'new.txt'), 'new\n');          // ticked, never added
  fs.rmSync(path.join(r.root, 'gone.txt'));                         // ticked deletion
  fs.writeFileSync(path.join(r.root, 'other.txt'), 'untouched\n');  // not ticked
  await r.api.commit({ repo: r.root, files: ['a.txt', 'new.txt', 'gone.txt'], summary: 'second' });
  const committed = r.g('show', '--name-status', '--format=', 'HEAD').trim().split('\n').sort();
  assert.deepStrictEqual(committed, ['A\tnew.txt', 'D\tgone.txt', 'M\ta.txt']);
  const status = r.g('status', '--porcelain').split('\n').filter(Boolean).sort();
  assert.deepStrictEqual(status, ['?? other.txt', 'M  b.txt']);      // b.txt is still staged
});

test('the very first commit of a repository still works', { skip: process.platform === 'win32' || !hasGit() }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-git-'));
  const g = (...a) => execFileSync('git', a, { cwd: root, encoding: 'utf8' });
  g('init', '-q'); g('config', 'user.name', 'T'); g('config', 'user.email', 't@t');
  fs.writeFileSync(path.join(root, 'one.txt'), '1'); fs.writeFileSync(path.join(root, 'two.txt'), '2');
  const api = gitMod.create({ check: p => path.resolve(p), root: () => root, Problem });
  await api.commit({ repo: root, files: ['one.txt'], summary: 'start' });
  assert.strictEqual(g('show', '--name-only', '--format=', 'HEAD').trim(), 'one.txt');
});
