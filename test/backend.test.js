// Run with: npm test
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { create, Problem } = require('../backend');

function tree() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-test-'));
  const root = path.join(base, 'root'), outside = path.join(base, 'outside'), twin = path.join(base, 'rootbeer');
  for (const d of [path.join(root, 'proj', 'src'), path.join(root, 'proj', 'build', 'obj'), outside, twin]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(root, 'proj', 'src', 'main.c'), 'int main(){}');
  fs.writeFileSync(path.join(root, 'proj', 'build', 'obj', 'main.o'), 'x');
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'no');
  return { base, root, outside, twin };
}

test('paths inside the root are allowed, with or without the item existing yet', () => {
  const t = tree(), b = create({ workspace: t.root });
  assert.ok(b.check(path.join(t.root, 'proj', 'src', 'main.c')));
  assert.ok(b.check(path.join(t.root, 'proj', 'not-made-yet', 'a.txt')));
  assert.ok(b.check(t.root));
});

test('paths outside the root are refused, including a neighbour whose name starts the same', () => {
  const t = tree(), b = create({ workspace: t.root });
  assert.throws(() => b.check(path.join(t.outside, 'secret.txt')), Problem);
  assert.throws(() => b.check(t.twin), Problem);
  assert.throws(() => b.check(path.join(t.root, '..', 'outside', 'secret.txt')), Problem);
});

test('a link inside the root that points outside it is refused (audit issue 2)', t0 => {
  const t = tree(), b = create({ workspace: t.root });
  const link = path.join(t.root, 'way-out');
  try { fs.symlinkSync(t.outside, link, 'junction'); } catch (e) { return t0.skip('this machine does not allow making links'); }
  assert.throws(() => b.check(path.join(link, 'secret.txt')), Problem);
  assert.throws(() => b.check(link), Problem);
});

test('a link inside the root that points back inside it still works', t0 => {
  const t = tree(), b = create({ workspace: t.root });
  const link = path.join(t.root, 'shortcut');
  try { fs.symlinkSync(path.join(t.root, 'proj', 'src'), link, 'junction'); } catch (e) { return t0.skip('this machine does not allow making links'); }
  assert.ok(b.check(path.join(link, 'main.c')));
});

test('search finds a build folder by name but does not crawl inside it (audit issue 4)', async () => {
  const t = tree(), b = create({ workspace: t.root });
  b.startIndexing();
  for (let i = 0; i < 100 && !b.search({ q: 'main' }).ready; i++) await new Promise(r => setTimeout(r, 20));
  const names = q => b.search({ q }).results.map(r => r.name);
  assert.deepStrictEqual(names('main.c'), ['main.c']);
  assert.deepStrictEqual(names('build'), ['build']);
  assert.deepStrictEqual(names('main.o'), []);
});

test('the board keeps notes and strips ".." out of folder tags', async () => {
  const t = tree(), b = create({ workspace: t.root });
  await b.boardSave({ notes: [{ id: 'abcdef12', x: 5, y: 6, c: 2, parts: [{ t: 'fix ' }, { p: '../../outside/proj' }, { p: 'proj\\src' }] }] });
  const got = (await b.boardGet()).notes[0];
  assert.strictEqual(got.parts[0].t, 'fix ');
  assert.strictEqual(got.parts[1].p, 'outside/proj');
  assert.strictEqual(got.parts[2].p, 'proj/src');
});

test('deleting with no root folder chosen gives a clear message instead of crashing (audit issue 5)', async () => {
  const t = tree(), b = create({});
  await assert.rejects(() => b.remove({ paths: [path.join(t.outside, 'secret.txt')] }), Problem);
});

test('properties add up a folder', async () => {
  const t = tree(), b = create({ workspace: t.root });
  const p = await b.props({ paths: [path.join(t.root, 'proj')] });
  assert.strictEqual(p.dir, true); assert.strictEqual(p.files, 2); assert.strictEqual(p.folders, 3); assert.strictEqual(p.size, 13);
});
