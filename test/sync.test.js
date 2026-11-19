const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { Problem } = require('../backend');

process.env.LOOM_SYNC_TEST = '1';                 // lets the test use a local folder as the "GitHub" repository
process.env.FOLDERMAP_CLAUDE = '';
const syncLib = require('../sync');
function hasGit() { try { execFileSync('git', ['--version']); return true; } catch (e) { return false; } }
const sh = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8' });

function world() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-sync-'));
  const root = path.join(base, 'Projects'), remote = path.join(base, 'remote.git');
  fs.mkdirSync(path.join(root, 'BlackWater', 'docs'), { recursive: true });
  fs.mkdirSync(path.join(root, 'BlackWater', 'build'), { recursive: true });
  fs.mkdirSync(path.join(root, 'Radio Device'), { recursive: true });
  fs.mkdirSync(path.join(root, '.folder-map', 'chats'), { recursive: true });
  fs.writeFileSync(path.join(root, 'BlackWater', 'CLAUDE.md'), '# BlackWater rules\n');
  fs.writeFileSync(path.join(root, 'BlackWater', 'docs', 'PROJECT_SCOPE.md'), '# Scope\nA node based DAW.\n');
  fs.writeFileSync(path.join(root, 'BlackWater', 'engine.cpp'), 'int main(){}\n');
  fs.writeFileSync(path.join(root, 'BlackWater', 'build', 'huge.bin'), Buffer.alloc(1024));
  fs.writeFileSync(path.join(root, '.folder-map', 'board.json'), JSON.stringify({ notes: [{ id: 'abcdef12', parts: [{ t: 'reverb update on ' }, { p: 'BlackWater' }] }] }));
  fs.writeFileSync(path.join(root, '.folder-map', 'chats', 'chat0001.json'), JSON.stringify({ title: 'Reverb plan', at: Date.now(), msgs: [
    { role: 'user', text: 'lets plan the reverb node' }, { role: 'ai', parts: [{ k: 'tool', write: true, line: 'Writing reverb.md' }, { k: 'text', text: 'Plan saved. Tail length is the open question.' }] }] }));
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', remote]);
  return { base, root, remote };
}

test('sync writes the handoff, maps projects without copying them, and pushes', { skip: process.platform === 'win32' || !hasGit(), timeout: 60000 }, async () => {
  const w = world(), s = syncLib.create({ root: () => w.root, Problem });
  assert.strictEqual((await s.status()).set, false);
  await s.setup({ url: w.remote });
  const r = await s.run();
  assert.strictEqual(r.ok, true); assert.strictEqual(r.chats, 1); assert.strictEqual(r.projects, 2);
  const check = path.join(w.base, 'check'); sh(w.base, 'clone', '-q', w.remote, 'check');
  const read = (...p) => fs.readFileSync(path.join(check, ...p), 'utf8');
  assert.match(read('LATEST.md'), /Reverb plan/);
  assert.match(read('LATEST.md'), /reverb update on \/BlackWater/);
  assert.match(read('CLAUDE.md'), /catch up/);
  assert.match(read('projects', 'BlackWater', 'TREE.md'), /engine\.cpp/);
  assert.match(read('projects', 'BlackWater', 'TREE.md'), /build\/ {2}\(not listed\)/);
  assert.strictEqual(read('projects', 'BlackWater', 'files', 'docs', 'PROJECT_SCOPE.md'), '# Scope\nA node based DAW.\n');
  assert.ok(!fs.existsSync(path.join(check, 'projects', 'BlackWater', 'files', 'engine.cpp')));   // project files are not uploaded
  assert.ok(fs.existsSync(path.join(check, 'projects', 'Radio Device', 'STATUS.md')));

  // The phone writes a note on its own branch. The next sync pulls it in and does not repeat old chats.
  sh(check, 'config', 'user.name', 'P'); sh(check, 'config', 'user.email', 'p@p');
  sh(check, 'checkout', '-q', '-b', 'claude/phone-notes');
  fs.writeFileSync(path.join(check, 'log', '2026-11-19-0900-phone.md'), '# From the phone\nDecided: tail length 12 seconds.\n');
  sh(check, 'add', '-A'); sh(check, 'commit', '-q', '-m', 'phone notes'); sh(check, 'push', '-q', 'origin', 'claude/phone-notes');
  const r2 = await s.run();
  assert.deepStrictEqual(r2.fromPhone, ['2026-11-19-0900-phone.md']);
  assert.strictEqual(r2.chats, 0);
  assert.ok(fs.existsSync(path.join(s.dir(), 'log', '2026-11-19-0900-phone.md')));
  assert.match(sh(check, 'ls-remote', '--heads', 'origin', 'main'), /refs\/heads\/main/);
  sh(check, 'checkout', '-q', 'main'); sh(check, 'pull', '-q');
  assert.ok(fs.existsSync(path.join(check, 'log', '2026-11-19-0900-phone.md')));           // merged into main on GitHub
});

test('a made-up address is refused', async () => {
  delete process.env.LOOM_SYNC_TEST;
  const w = world(), s = syncLib.create({ root: () => w.root, Problem });
  await assert.rejects(() => s.setup({ url: 'https://example.com/x/y' }), Problem);
  await assert.rejects(() => s.setup({ url: 'C:\\somewhere' }), Problem);
  process.env.LOOM_SYNC_TEST = '1';
});
