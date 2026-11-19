// Natural voices: Piper, a neural text-to-speech engine that runs on this PC, offline.
// Nothing is bundled with Loom. The engine and each voice are downloaded the first time someone
// picks one, checked against the SHA-256 pinned below, and kept in %APPDATA%\Folder Map\piper.
// A download that does not match is thrown away, never run.
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawn, execFile } = require('child_process');

const { Problem } = require('./backend');

const ENGINE = {
  url: 'https://github.com/rhasspy/piper/releases/download/2023.11.14-2/piper_windows_amd64.zip',
  sha256: 'f3c58906402b24f3a96d92145f58acba6d86c9b5db896d207f78dc80811efcea',
  size: 22477236,
};
// Pinned to the v1.0.0 tag of rhasspy/piper-voices, so the files behind these addresses cannot change.
const HF = 'https://huggingface.co/rhasspy/piper-voices/resolve/v1.0.0/en/';
const VOICE_SIZE = 63201294;
const VOICES = [
  { id: 'en_US-lessac-medium', name: 'Lessac', who: 'US, woman', dir: 'en_US/lessac/medium',
    onnx: '5efe09e69902187827af646e1a6e9d269dee769f9877d17b16b1b46eeaaf019f', json: 'efe19c417bed055f2d69908248c6ba650fa135bc868b0e6abb3da181dab690a0' },
  { id: 'en_US-ryan-medium', name: 'Ryan', who: 'US, man', dir: 'en_US/ryan/medium',
    onnx: 'abf4c274862564ed647ba0d2c47f8ee7c9b717d27bdad9219100eb310db4047a', json: '44034c056cb15681b2ad494307c7f3f2e4499d1253c700c711fa0a4607ffe78d' },
  { id: 'en_US-amy-medium', name: 'Amy', who: 'US, woman', dir: 'en_US/amy/medium',
    onnx: 'b3a6e47b57b8c7fbe6a0ce2518161a50f59a9cdd8a50835c02cb02bdd6206c18', json: '95a23eb4d42909d38df73bb9ac7f45f597dbfcde2d1bf9526fdeaf5466977d77' },
  { id: 'en_GB-alan-medium', name: 'Alan', who: 'British, man', dir: 'en_GB/alan/medium',
    onnx: '0a309668932205e762801f1efc2736cd4b0120329622adf62be09e56339d3330', json: 'c0f0d124e5895c00e7c03b35dcc8287f319a6998a365b182deb5c8e752ee8c1e' },
  { id: 'en_GB-jenny_dioco-medium', name: 'Jenny', who: 'British, woman', dir: 'en_GB/jenny_dioco/medium',
    onnx: '469c630d209e139dd392a66bf4abde4ab86390a0269c1e47b4e5d7ce81526b01', json: 'a9a7a93a317c9a3cb6563e37eb057df9ef09c06188a8a4341b0fcb58cba54dd4' },
];
const byId = id => VOICES.find(v => v.id === id) || null;

// Download one file to `dest`, hashing as it streams. Only a file with the right hash is kept.
async function fetchChecked(url, sha256, dest, onBytes, fetchImpl = globalThis.fetch) {
  const part = dest + '.part';
  let res;
  try { res = await fetchImpl(url, { redirect: 'follow' }); }
  catch (e) { throw new Problem('Could not reach the download. Check the internet connection.\n' + (e.message || e)); }
  if (!res.ok || !res.body) throw new Problem('The download failed (' + res.status + ').');
  const hash = crypto.createHash('sha256'), out = fs.createWriteStream(part);
  try {
    for await (const chunk of res.body) {
      const b = Buffer.from(chunk); hash.update(b); onBytes(b.length);
      if (!out.write(b)) await new Promise(r => out.once('drain', r));
    }
    await new Promise((r, j) => out.end(e => (e ? j(e) : r())));
  } catch (e) { out.destroy(); await fsp.rm(part, { force: true }); throw e; }
  if (hash.digest('hex') !== sha256) {
    await fsp.rm(part, { force: true });
    throw new Problem('The downloaded file did not match the expected one, so it was thrown away. Nothing was installed.');
  }
  await fsp.rename(part, dest);
}

function create({ dir, fetchImpl, tar = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe') }) {
  const engineDir = path.join(dir, 'engine'), voicesDir = path.join(dir, 'voices');
  const exe = () => path.join(engineDir, 'piper', 'piper.exe');
  const model = v => path.join(voicesDir, v.id + '.onnx');
  const installed = v => fs.existsSync(model(v)) && fs.existsSync(model(v) + '.json');
  let job = null;   // { id, got, total, error, done }

  function list() {
    return { engine: fs.existsSync(exe()), voices: VOICES.map(v => ({ id: v.id, name: v.name, who: v.who, size: VOICE_SIZE, installed: installed(v) })) };
  }
  function progress() { return job ? { id: job.id, got: job.got, total: job.total, done: job.done, error: job.error } : null; }

  // Fetch whatever is missing for this voice: the engine the first time, then the voice itself.
  async function install({ id }) {
    const v = byId(id);
    if (!v) throw new Problem('That voice is not on the list.');
    if (job && !job.done) throw new Problem('A voice is already downloading.');
    if (process.platform !== 'win32') throw new Problem('Natural voices are only set up for Windows.');
    const needEngine = !fs.existsSync(exe()), needVoice = !installed(v);
    job = { id, got: 0, total: (needEngine ? ENGINE.size : 0) + (needVoice ? VOICE_SIZE + 5000 : 0), done: false, error: null };
    const tick = n => { job.got += n; };
    try {
      await fsp.mkdir(voicesDir, { recursive: true });
      if (needEngine) {
        const zip = path.join(dir, 'piper.zip'), fresh = path.join(dir, 'engine.new');
        await fetchChecked(ENGINE.url, ENGINE.sha256, zip, tick, fetchImpl);
        await fsp.rm(fresh, { recursive: true, force: true }); await fsp.mkdir(fresh, { recursive: true });
        await new Promise((r, j) => execFile(tar, ['-xf', zip, '-C', fresh], { windowsHide: true }, e => (e ? j(new Problem('Could not unpack the voice engine: ' + e.message)) : r())));
        if (!fs.existsSync(path.join(fresh, 'piper', 'piper.exe'))) throw new Problem('The voice engine download did not contain piper.exe.');
        await fsp.rm(engineDir, { recursive: true, force: true }); await fsp.rename(fresh, engineDir); await fsp.rm(zip, { force: true });
      }
      if (needVoice) {
        await fetchChecked(HF + v.dir + '/' + v.id + '.onnx.json', v.json, model(v) + '.json', tick, fetchImpl);
        await fetchChecked(HF + v.dir + '/' + v.id + '.onnx', v.onnx, model(v), tick, fetchImpl);
      }
      job.done = true; job.got = job.total;
      return list();
    } catch (e) { job.done = true; job.error = e.message || String(e); throw e; }
  }

  // Turn one piece of text into a WAV file and hand back its bytes. Faster speech = shorter length_scale.
  async function say({ id, text, rate }) {
    const v = byId(id);
    if (!v || !installed(v) || !fs.existsSync(exe())) throw new Problem('That voice is not downloaded yet. Pick it again under Settings, Voice and speed.');
    const words = String(text || '').replace(/\s+/g, ' ').trim().slice(0, 2000);
    if (!words) return { wav: null };
    const scale = (1 / Math.max(0.5, Math.min(2, Number(rate) || 1))).toFixed(3);
    const out = path.join(os.tmpdir(), 'loom-voice-' + crypto.randomBytes(6).toString('hex') + '.wav');
    await new Promise((resolve, reject) => {
      const p = spawn(exe(), ['--model', model(v), '--output_file', out, '--length_scale', scale],
        { cwd: path.dirname(exe()), windowsHide: true, stdio: ['pipe', 'ignore', 'pipe'] });
      let err = '';
      const timer = setTimeout(() => p.kill(), 60000);
      p.stderr.on('data', d => { err = (err + d).slice(-2000); });
      p.on('error', e => { clearTimeout(timer); reject(new Problem('Could not start the voice engine: ' + e.message)); });
      p.on('close', code => { clearTimeout(timer); code === 0 ? resolve() : reject(new Problem('The voice engine stopped with a problem.\n' + err.trim())); });
      p.stdin.on('error', () => {});
      p.stdin.end(words + '\n');
    });
    try { return { wav: await fsp.readFile(out) }; } finally { fsp.rm(out, { force: true }).catch(() => {}); }
  }

  return { list, install, progress, say };
}

module.exports = { create, VOICES, ENGINE, fetchChecked, Problem };
