const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { create, VOICES, fetchChecked } = require('../voice');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'loom-voice-'));
const fake = body => async () => ({ ok: true, status: 200, body: (async function* () { yield Buffer.from(body); })() });
const sha = s => crypto.createHash('sha256').update(s).digest('hex');

test('a download with the right fingerprint is kept', async () => {
  const d = tmp(), dest = path.join(d, 'a.bin'); let n = 0;
  await fetchChecked('http://x', sha('hello'), dest, b => { n += b; }, fake('hello'));
  assert.strictEqual(fs.readFileSync(dest, 'utf8'), 'hello'); assert.strictEqual(n, 5);
});

test('a download with the wrong fingerprint is thrown away', async () => {
  const d = tmp(), dest = path.join(d, 'a.bin');
  await assert.rejects(fetchChecked('http://x', sha('hello'), dest, () => {}, fake('tampered')), /did not match/);
  assert.deepStrictEqual(fs.readdirSync(d), []);
});

test('nothing is installed at first, and an unknown voice is refused', async () => {
  const v = create({ dir: tmp() }), l = v.list();
  assert.strictEqual(l.engine, false);
  assert.strictEqual(l.voices.length, VOICES.length);
  assert.ok(l.voices.every(x => !x.installed));
  await assert.rejects(v.install({ id: '../../evil' }), /not on the list/);
  await assert.rejects(v.say({ id: VOICES[0].id, text: 'hi' }), /not downloaded/);
});
