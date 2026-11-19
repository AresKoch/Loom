// Loom backend: everything that touches the disk.
// No Electron in here, so the same code runs under the test server.
//
// What it can do:
//   - list folders in the workspace and on plugged in USB drives
//   - copy, move, rename, and make folders, in the workspace and on USB drives
//   - delete: permanent on a USB drive; in the workspace it only MOVES the item
//     into .folder-map-trash\<date time>\ so it can be put back
//   - print a file with whatever program Windows has set up for it
// It cannot reach anything outside the workspace folder and plugged in USB drives.
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { execFile } = require('child_process');

const SKIP_DIRS = new Set(['node_modules', '.git', '__pycache__', '.venv', 'venv', '.pytest_cache',
  'System Volume Information', '$RECYCLE.BIN']);
const SKIP_FILES = new Set(['thumbs.db', 'desktop.ini']);
const PRINTABLE = new Set(['pdf', 'doc', 'docx', 'rtf', 'txt', 'xls', 'xlsx', 'csv', 'ppt', 'pptx',
  'png', 'jpg', 'jpeg', 'bmp', 'gif', 'tif', 'tiff', 'nc', 'md']);

const TRASH = '.folder-map-trash';
const STORE = '.folder-map';          // the app's own shared data inside the root folder (chats). Not shown in the browser.

class Problem extends Error {}

function create({ workspace, fakeUsb }) {
  let WORKSPACE = workspace ? path.resolve(workspace) : null;   // the root folder; changeable with setRoot
  const norm = p => path.resolve(p).toLowerCase();
  const inside = (p, root) => {
    const a = norm(p), r = norm(root).replace(/\\+$/, '');
    return a === r || a.startsWith(r + '\\');
  };
  const visibleFile = n => !(SKIP_FILES.has(n.toLowerCase()) || n.startsWith('~$'));

  // ---------- USB drives ----------
  let drives = [];
  let lastLetters = null;
  let querying = null;

  function lettersPresent() {
    let s = '';
    for (let c = 68; c <= 90; c++) { // D to Z
      const l = String.fromCharCode(c);
      try { if (fs.existsSync(l + ':\\')) s += l; } catch (e) { /* not ready */ }
    }
    return s;
  }
  function queryDrives() {
    if (querying) return querying;
    querying = new Promise(resolve => {
      const ps = 'Get-CimInstance Win32_LogicalDisk -Filter "DriveType=2" | ' +
        'Select-Object DeviceID,VolumeName,FreeSpace,Size | ConvertTo-Json -Compress';
      execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps],
        { windowsHide: true, timeout: 15000 }, (err, out) => {
          const found = [];
          if (!err && out && out.trim()) {
            try {
              let rows = JSON.parse(out);
              if (!Array.isArray(rows)) rows = [rows];
              for (const r of rows) {
                if (!r || !r.Size) continue; // empty card reader slot
                found.push({ root: r.DeviceID + '\\', letter: r.DeviceID, label: r.VolumeName || 'USB drive',
                  free: Number(r.FreeSpace) || 0, total: Number(r.Size) || 0 });
              }
            } catch (e) { /* keep empty */ }
          }
          if (fakeUsb) found.unshift({ root: path.resolve(fakeUsb), letter: '', label: 'TEST USB', free: 0, total: 0 });
          drives = found;
          querying = null;
          resolve(found);
        });
    });
    return querying;
  }
  async function getDrives(force) {
    const letters = lettersPresent();
    if (force || letters !== lastLetters) { lastLetters = letters; await queryDrives(); }
    const out = [];
    for (const d of drives) {
      let folders = [];
      try {
        const ents = await fsp.readdir(d.root, { withFileTypes: true });
        folders = ents.filter(e => e.isDirectory() && !SKIP_DIRS.has(e.name) && !e.name.startsWith('.'))
          .map(e => e.name).sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }))
          .slice(0, 40).map(n => ({ name: n, path: path.join(d.root, n) }));
      } catch (e) { continue; } // pulled out
      out.push({ ...d, folders });
    }
    return { drives: out };
  }
  const usbRootOf = p => { const d = drives.find(x => inside(p, x.root)); return d ? d.root : null; };

  function check(p) {
    if (!p || typeof p !== 'string') throw new Problem('No path given.');
    const ap = path.resolve(p);
    if ((WORKSPACE && inside(ap, WORKSPACE)) || usbRootOf(ap)) return ap;
    throw new Problem(WORKSPACE ? 'That location is outside the root folder and USB drives.' : 'Choose a root folder first.');
  }

  // ---------- listing ----------
  const byName = (a, b) => a.localeCompare(b, undefined, { sensitivity: 'base', numeric: true });
  async function peek(dir) {
    let ents;
    try { ents = await fsp.readdir(dir, { withFileTypes: true }); }
    catch (e) { return { nd: 0, nf: 0, peek: [], err: true }; }
    const dirs = ents.filter(e => e.isDirectory() && e.name !== STORE).map(e => e.name).sort(byName);
    const files = ents.filter(e => !e.isDirectory() && visibleFile(e.name)).map(e => e.name).sort(byName);
    const first = dirs.slice(0, 18).map(n => [n, 1]);
    for (const n of files.slice(0, Math.max(0, 28 - first.length))) first.push([n, 0]);
    return { nd: dirs.length, nf: files.length, peek: first };
  }
  async function ls({ path: p }) {
    if (!p && !WORKSPACE) throw new Problem('Choose a root folder first.');
    const ap = check(p || WORKSPACE);
    let ents;
    try { ents = await fsp.readdir(ap, { withFileTypes: true }); }
    catch (e) { throw new Problem('That folder is not there any more.'); }
    const dirs = await Promise.all(ents.filter(e => e.isDirectory() && e.name !== STORE).map(async e => {
      const full = path.join(ap, e.name);
      if (SKIP_DIRS.has(e.name)) return { name: e.name, path: full, skip: true, nd: 0, nf: 0, peek: [] };
      return { name: e.name, path: full, ...(await peek(full)) };
    }));
    const files = (await Promise.all(ents.filter(e => !e.isDirectory() && visibleFile(e.name)).map(async e => {
      const full = path.join(ap, e.name);
      try {
        const st = await fsp.stat(full);
        const ext = e.name.includes('.') ? e.name.split('.').pop().toLowerCase() : '';
        return { name: e.name, path: full, size: st.size, mtime: st.mtimeMs, ext, printable: PRINTABLE.has(ext) };
      } catch (err) { return null; }
    }))).filter(Boolean);
    dirs.sort((a, b) => byName(a.name, b.name));
    files.sort((a, b) => byName(a.name, b.name));

    const usb = usbRootOf(ap);
    const top = usb || WORKSPACE;
    const crumbs = [];
    for (let cur = ap; ;) {
      const atTop = norm(cur) === norm(top);
      crumbs.unshift({ path: cur, name: atTop && usb ? usbName(usb) : path.basename(cur) || cur });
      if (atTop) break;
      cur = path.dirname(cur);
    }
    return { path: ap, name: crumbs[crumbs.length - 1].name, usb: !!usb,
      parent: crumbs.length > 1 ? crumbs[crumbs.length - 2] : null, crumbs, dirs, files };
  }
  function usbName(root) {
    const d = drives.find(x => norm(x.root) === norm(root));
    return d ? (d.letter ? `${d.label} (${d.letter})` : d.label) : root;
  }

  // ---------- search ----------
  let index = [];
  let indexReady = false;
  let indexGen = 0;
  async function buildIndex() {
    const gen = indexGen, root = WORKSPACE;
    if (!root) { index = []; indexReady = true; return; }
    const items = [];
    const walk = async dir => {
      let ents;
      try { ents = await fsp.readdir(dir, { withFileTypes: true }); } catch (e) { return; }
      for (const e of ents) {
        if (gen !== indexGen || items.length > 250000) return;   // root changed, or a huge drive: stop here
        if (e.isDirectory()) {
          if (SKIP_DIRS.has(e.name) || e.name === TRASH || e.name === STORE) continue;
          items.push([e.name.toLowerCase(), e.name, dir, true]);
          await walk(path.join(dir, e.name));
        } else if (visibleFile(e.name)) items.push([e.name.toLowerCase(), e.name, dir, false]);
      }
    };
    await walk(root);
    if (gen !== indexGen) return;
    index = items;
    indexReady = true;
  }
  let reindexT = null;
  function reindex() {          // after a change, refresh search shortly
    clearTimeout(reindexT);
    reindexT = setTimeout(() => buildIndex().catch(() => {}), 1500);
    if (reindexT.unref) reindexT.unref();
  }
  function startIndexing() {
    const loop = () => buildIndex().catch(() => {}).then(() => setTimeout(loop, 5 * 60 * 1000).unref());
    loop();
  }
  function search({ q }) {
    const terms = String(q || '').toLowerCase().split(/\s+/).filter(Boolean);
    if (!terms.length) return { results: [], ready: indexReady };
    const hits = index.filter(it => terms.every(t => it[0].includes(t)));
    const rank = it => (it[3] ? 0 : 2) + (it[0].startsWith(terms[0]) ? 0 : 1);
    hits.sort((a, b) => rank(a) - rank(b) || a[0].length - b[0].length);
    return { ready: indexReady, total: hits.length, results: hits.slice(0, 60).map(([, name, dir, isDir]) => ({
      name, dir: isDir, folder: dir, path: path.join(dir, name),
      where: path.relative(WORKSPACE, dir) || path.basename(WORKSPACE) })) };
  }

  // ---------- copy to USB ----------
  async function exists(p) { try { await fsp.access(p); return true; } catch (e) { return false; } }
  async function treeSize(p) {
    const st = await fsp.stat(p);
    if (!st.isDirectory()) return st.size;
    let total = 0;
    for (const e of await fsp.readdir(p, { withFileTypes: true })) {
      try { total += await treeSize(path.join(p, e.name)); } catch (err) { /* skip */ }
    }
    return total;
  }
  async function unique(dest) {
    const ext = path.extname(dest), stem = dest.slice(0, dest.length - ext.length);
    for (let i = 2; ; i++) { const c = `${stem} (${i})${ext}`; if (!(await exists(c))) return c; }
  }
  const topOf = p => usbRootOf(p) || WORKSPACE;

  // ---------- root folder ----------
  async function setRoot({ path: p }) {
    if (!p || typeof p !== 'string') throw new Problem('No folder given.');
    const ap = path.resolve(p);
    let st; try { st = await fsp.stat(ap); } catch (e) { st = null; }
    if (!st || !st.isDirectory()) throw new Problem('That folder is not there.');
    WORKSPACE = ap; indexGen++; index = []; indexReady = false;
    buildIndex().catch(() => {});
    return { home: WORKSPACE };
  }

  // ---------- shared chats ----------
  // Chats are saved inside the root folder (ROOT\.folder-map\chats\<id>.json), not on one PC.
  // Everyone who opens the same root folder sees the same chats.
  const chatDir = () => path.join(WORKSPACE, STORE, 'chats');
  const goodId = id => typeof id === 'string' && /^[a-z0-9]{6,24}$/.test(id);
  const me = () => ({ user: (process.env.USERNAME || 'someone'), pc: (process.env.COMPUTERNAME || 'this PC') });
  // known = { id: time last seen }. Sends back every chat id, plus the full chat for new or changed ones.
  async function chatsList({ known }) {
    if (!WORKSPACE) return { ids: [], changed: [], me: me() };
    known = known || {};
    let names = [];
    try { names = (await fsp.readdir(chatDir())).filter(n => n.endsWith('.json')); } catch (e) { /* none yet */ }
    const ids = [], changed = [];
    for (const n of names) {
      const id = n.slice(0, -5); if (!goodId(id)) continue;
      try {
        const st = await fsp.stat(path.join(chatDir(), n));
        ids.push(id);
        if (known[id] !== st.mtimeMs) {
          const c = JSON.parse(await fsp.readFile(path.join(chatDir(), n), 'utf8'));
          c.id = id; c._m = st.mtimeMs; changed.push(c);
        }
      } catch (e) { /* being written right now: pick it up next time */ }
    }
    return { ids, changed, me: me() };
  }
  async function chatSave({ chat }) {
    if (!WORKSPACE) throw new Problem('Choose a root folder first.');
    if (!chat || !goodId(chat.id)) throw new Problem('Bad chat.');
    await fsp.mkdir(chatDir(), { recursive: true });
    const file = path.join(chatDir(), chat.id + '.json'), tmp = file + '.' + process.pid + '.tmp';
    const body = { title: String(chat.title || 'New chat').slice(0, 120), at: Number(chat.at) || Date.now(), session: chat.session || null,
      sessionPc: chat.sessionPc || null, startedBy: chat.startedBy || null, msgs: Array.isArray(chat.msgs) ? chat.msgs.slice(-200) : [] };
    await fsp.writeFile(tmp, JSON.stringify(body));
    await fsp.rename(tmp, file);
    return { _m: (await fsp.stat(file)).mtimeMs };
  }
  async function chatDelete({ id }) {
    if (!WORKSPACE || !goodId(id)) throw new Problem('Bad chat.');
    await fsp.rm(path.join(chatDir(), id + '.json'), { force: true });
    return { ok: true };
  }

  // ---------- quick look at a file ----------
  const TEXT_EXT = new Set(['txt', 'md', 'nc', 'tap', 'gcode', 'ngc', 'py', 'js', 'mjs', 'ts', 'tsx', 'jsx', 'json', 'html', 'htm', 'css', 'csv', 'tsv',
    'bat', 'cmd', 'ps1', 'sh', 'xml', 'yml', 'yaml', 'ini', 'cfg', 'conf', 'log', 'sql', 'c', 'h', 'cpp', 'hpp', 'cs', 'java', 'go', 'rs', 'rb', 'php',
    'step', 'stp', 'iges', 'igs', 'dxf', 'toml', 'env', 'gitignore', 'vbs', 'lua', 'r']);
  // SolidWorks parts, assemblies and drawings store a small picture of the model inside the file,
  // as a compressed block named "PreviewPNG". Each block starts with the bytes 14 00 06 00 08 00,
  // then sizes, then the block name with the two halves of every byte swapped, then the data.
  const SW_EXT = new Set(['sldprt', 'sldasm', 'slddrw']);
  const SW_MARK = Buffer.from([0x14, 0x00, 0x06, 0x00, 0x08, 0x00]);
  async function solidworksPicture(ap) {
    const st = await fsp.stat(ap);
    if (st.size > 150 * 1024 * 1024) return null;
    const data = await fsp.readFile(ap);
    for (let pos = data.indexOf(SW_MARK); pos >= 0 && pos + 26 < data.length; pos = data.indexOf(SW_MARK, pos + 6)) {
      const packed = data.readUInt32LE(pos + 14), nameLen = data.readUInt32LE(pos + 22);
      if (nameLen !== 10 || pos + 36 + packed > data.length) continue;
      let name = '';
      for (let i = 0; i < nameLen; i++) { const b = data[pos + 26 + i]; name += String.fromCharCode(((b & 0x0f) << 4) | (b >> 4)); }
      if (name !== 'PreviewPNG') continue;
      try {
        const png = require('zlib').inflateRawSync(data.subarray(pos + 36, pos + 36 + packed));
        if (png[0] === 0x89 && png[1] === 0x50) return 'data:image/png;base64,' + png.toString('base64');
      } catch (e) { /* damaged block: keep looking */ }
    }
    return null;
  }
  async function preview({ path: p }) {
    const ap = check(p);
    const ext = path.basename(ap).includes('.') ? ap.split('.').pop().toLowerCase() : '';
    if (SW_EXT.has(ext)) {
      try { const url = await solidworksPicture(ap); if (url) return { kind: 'img', ext, url }; } catch (e) { /* fall through */ }
      return { kind: 'none', ext };
    }
    if (!TEXT_EXT.has(ext)) return { kind: 'none', ext };
    let fh;
    try {
      fh = await fsp.open(ap, 'r');
      const buf = Buffer.alloc(12000);
      const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
      const st = await fh.stat();
      const chunk = buf.subarray(0, bytesRead);
      if (chunk.includes(0)) return { kind: 'none', ext };            // binary despite the name
      const lines = chunk.toString('utf8').replace(/\r/g, '').split('\n');
      const more = st.size > bytesRead;
      if (more) lines.pop();                                           // last line is probably cut
      return { kind: 'text', ext, text: lines.slice(0, 120).join('\n'), more: more || lines.length > 120 };
    } catch (e) { return { kind: 'none', ext }; }
    finally { if (fh) await fh.close().catch(() => {}); }
  }
  async function moveOne(it, target) {
    const sameVolume = norm(topOf(it.sp)) === norm(topOf(target));
    if (sameVolume && !(it.isDir && await exists(target))) {
      try { await fsp.rename(it.sp, target); return; }
      catch (e) { if (e.code !== 'EXDEV') throw e; }
    }
    await fsp.cp(it.sp, target, { recursive: true, force: true, preserveTimestamps: true });
    await fsp.rm(it.sp, { recursive: true, force: false });
  }
  // Copy (or with move: true, move) files and folders into a folder in the workspace or on a USB drive.
  async function copy({ src, dest, mode, move }) {
    await getDrives(false);
    const to = check(dest);
    const root = usbRootOf(to);
    let st;
    try { st = await fsp.stat(to); } catch (e) { st = null; }
    if (!st || !st.isDirectory()) throw new Problem('That folder is not there. If it is on a USB drive, is the drive still plugged in?');
    if (!Array.isArray(src) || !src.length) throw new Problem('Nothing selected.');

    const items = [];
    for (const s of src) {
      const sp = check(s);
      if (!(await exists(sp))) throw new Problem(`${path.basename(sp)} is not there any more.`);
      const isDir = (await fsp.stat(sp)).isDirectory();
      if (isDir && inside(to, sp)) throw new Problem('A folder cannot be copied into itself.');
      if (norm(sp) === norm(topOf(sp))) throw new Problem('The top folder itself cannot be moved or copied.');
      const target = path.join(to, path.basename(sp));
      const same = norm(target) === norm(sp);   // pasting into the folder it is already in
      if (same && move) throw new Problem(`${path.basename(sp)} is already in that folder.`);
      items.push({ sp, target, isDir, same });
    }
    const conflicts = [];
    for (const it of items) if (!it.same && await exists(it.target)) conflicts.push(path.basename(it.target));
    if (conflicts.length && mode !== 'replace' && mode !== 'both') return { conflicts };

    const withinOneDrive = move && items.every(it => norm(topOf(it.sp)) === norm(topOf(to)));
    if (root && !withinOneDrive && !(fakeUsb && inside(to, fakeUsb))) {
      let need = 0;
      for (const it of items) need += await treeSize(it.sp);
      const sf = await fsp.statfs(root);
      const free = sf.bavail * sf.bsize;
      if (need > free) {
        throw new Problem(`Not enough room on the USB drive. Needs ${Math.ceil(need / 1048576)} MB, ` +
          `${Math.floor(free / 1048576)} MB free.`);
      }
    }
    const copied = [];
    for (const it of items) {
      let target = it.target;
      if ((mode === 'both' || it.same) && await exists(target)) target = await unique(target);
      if (move) await moveOne(it, target);
      else await fsp.cp(it.sp, target, { recursive: true, force: true, preserveTimestamps: true });
      copied.push(path.basename(target));
    }
    lastLetters = null; // refresh free space next poll
    reindex();
    return { copied, dest: to, moved: !!move };
  }

  // ---------- rename, new folder ----------
  function cleanName(name) {
    const n = String(name || '').trim();
    if (!n || n === '.' || n === '..') throw new Problem('Type a name.');
    if (/[\\/:*?"<>|]/.test(n)) throw new Problem('A name cannot contain  \\ / : * ? " < > |');
    if (/[. ]$/.test(n)) throw new Problem('A name cannot end with a dot or a space.');
    if (n.length > 200) throw new Problem('That name is too long.');
    return n;
  }
  async function rename({ path: p, name }) {
    await getDrives(false);
    const ap = check(p), n = cleanName(name);
    if (norm(ap) === norm(topOf(ap))) throw new Problem('The top folder itself cannot be renamed.');
    if (!(await exists(ap))) throw new Problem('That is not there any more.');
    const target = path.join(path.dirname(ap), n);
    if (target === ap) return { path: ap };
    if (norm(target) !== norm(ap) && await exists(target)) throw new Problem(`There is already something named ${n} here.`);
    await fsp.rename(ap, target);
    reindex();
    return { path: target };
  }
  async function mkdir({ path: p, name }) {
    await getDrives(false);
    const dir = check(p), n = cleanName(name);
    const target = path.join(dir, n);
    if (await exists(target)) throw new Problem(`There is already something named ${n} here.`);
    await fsp.mkdir(target);
    reindex();
    return { path: target };
  }

  // ---------- delete ----------
  // USB drives have no Recycle Bin, so a delete there is permanent.
  // In the workspace nothing is destroyed: items are moved into TRASH\<date time>\ and can be dragged back.
  async function remove({ paths }) {
    await getDrives(false);
    if (!Array.isArray(paths) || !paths.length) throw new Problem('Nothing selected.');
    const items = [];
    const trashRoot = path.join(WORKSPACE, TRASH);
    for (const p of paths) {
      const ap = check(p);
      if (norm(ap) === norm(topOf(ap))) throw new Problem('The top folder itself cannot be deleted.');
      if (!(await exists(ap))) throw new Problem(`${path.basename(ap)} is not there any more.`);
      items.push(ap);
    }
    const deleted = [];
    let trashedTo = null;
    for (const ap of items) {
      if (usbRootOf(ap) || inside(ap, trashRoot)) {
        await fsp.rm(ap, { recursive: true, force: false });   // permanent: USB, or emptying the trash
      } else {
        if (!trashedTo) {
          const d = new Date(), z = n => String(n).padStart(2, '0');
          trashedTo = path.join(trashRoot, `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())} ${z(d.getHours())}${z(d.getMinutes())}${z(d.getSeconds())}`);
          await fsp.mkdir(trashedTo, { recursive: true });
        }
        let target = path.join(trashedTo, path.basename(ap));
        if (await exists(target)) target = await unique(target);
        await fsp.rename(ap, target);
      }
      deleted.push(path.basename(ap));
    }
    lastLetters = null;
    reindex();
    return { deleted, trash: trashedTo };
  }

  // ---------- print ----------
  function printOne(file) {
    return new Promise(resolve => {
      execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
        'try { Start-Process -FilePath $env:FM_FILE -Verb Print -ErrorAction Stop; exit 0 } catch { exit 1 }'],
        { windowsHide: true, timeout: 30000, env: { ...process.env, FM_FILE: file } },
        err => resolve(!err));
    });
  }
  async function print({ paths }) {
    const sent = [], failed = [];
    for (const p of paths || []) {
      const ap = check(p);
      (await exists(ap) && await printOne(ap) ? sent : failed).push(path.basename(ap));
    }
    return { sent, failed };
  }

  // ---------- compress to zip, properties ----------
  function run(cmd, args, opts) {
    return new Promise((resolve, reject) => execFile(cmd, args, { windowsHide: true, timeout: 15 * 60 * 1000, maxBuffer: 1 << 20, ...opts },
      (err, out, errOut) => (err ? reject(new Error(String(errOut || err.message).trim().split('\n')[0])) : resolve(out))));
  }
  // Makes <name>.zip beside the item (or beside the items, when several from one folder are picked).
  async function zip({ paths }) {
    await getDrives(false);
    const list = (paths || []).map(check);
    if (!list.length) throw new Problem('Nothing to compress.');
    const dir = path.dirname(list[0]);
    if (list.some(p => norm(path.dirname(p)) !== norm(dir))) throw new Problem('Pick items from one folder to compress them together.');
    for (const p of list) if (!(await exists(p))) throw new Problem(path.basename(p) + ' is not there any more.');
    const stem = list.length === 1 ? path.basename(list[0]).replace(/\.[^.]+$/, m => ((fs.statSync(list[0]).isDirectory()) ? m : '')) : path.basename(dir);
    let out = path.join(dir, stem + '.zip');
    if (await exists(out)) out = await unique(out);
    const names = list.map(p => path.basename(p)).map(n => (n.startsWith('-') || n.startsWith('@') ? './' + n : n));
    try {
      if (process.platform === 'win32') {
        const tar = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
        try { await run(tar, ['-a', '-c', '-f', out, ...names], { cwd: dir }); }
        catch (e) {                                        // older Windows without tar: PowerShell does it, slower
          await fsp.rm(out, { force: true });
          await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Compress-Archive -LiteralPath ($env:FM_ITEMS -split "`n") -DestinationPath $env:FM_OUT'],
            { cwd: dir, env: { ...process.env, FM_ITEMS: list.join('\n'), FM_OUT: out } });
        }
      } else await run('zip', ['-r', '-q', out, ...names], { cwd: dir });
    } catch (e) { await fsp.rm(out, { force: true }).catch(() => {}); throw new Problem('Could not make the zip file: ' + e.message); }
    reindex();
    return { path: out };
  }
  async function props({ paths }) {
    const list = (paths || []).map(check);
    if (!list.length) throw new Problem('Nothing picked.');
    const t = { size: 0, files: 0, folders: 0, seen: 0, partial: false };
    async function walk(p, top) {
      if (t.seen++ > 150000) { t.partial = true; return; }
      let st; try { st = await fsp.stat(p); } catch (e) { return; }
      if (!st.isDirectory()) { t.size += st.size; if (!top) t.files++; return; }
      if (!top) t.folders++;
      let ents = []; try { ents = await fsp.readdir(p); } catch (e) { /* no permission */ }
      for (const n of ents) await walk(path.join(p, n), false);
    }
    if (list.length > 1) {
      for (const p of list) { const st = await fsp.stat(p); if (st.isDirectory()) t.folders++; else t.files++; await walk(p, true); }
      return { many: true, name: list.length + ' items', type: 'Several items', location: path.dirname(list[0]), size: t.size, files: t.files, folders: t.folders, partial: t.partial };
    }
    const ap = list[0], st = await fsp.stat(ap), dir = st.isDirectory(), ext = path.extname(ap).slice(1);
    await walk(ap, true);
    return { name: path.basename(ap) || ap, dir, type: dir ? 'Folder' : (ext ? ext.toUpperCase() + ' file' : 'File'), location: path.dirname(ap),
      size: t.size, files: t.files, folders: t.folders, partial: t.partial, created: st.birthtimeMs, modified: st.mtimeMs };
  }

  // ---------- voice typing ----------
  // Opens Windows voice typing (the Win+H panel) by pressing Win+H for the person. Whatever
  // text box has the cursor gets the words, so the app only has to focus its own box first.
  async function dictate() {
    if (process.platform !== 'win32') throw new Problem('Voice typing uses Windows voice typing, so it only works on Windows.');
    const ps = "Add-Type -Namespace LoomW -Name K -MemberDefinition '[DllImport(\"user32.dll\")] public static extern void keybd_event(byte v, byte s, uint f, System.UIntPtr e);'; "
      + '$z = [UIntPtr]::Zero; [LoomW.K]::keybd_event(0x5B,0,0,$z); [LoomW.K]::keybd_event(0x48,0,0,$z); [LoomW.K]::keybd_event(0x48,0,2,$z); [LoomW.K]::keybd_event(0x5B,0,2,$z)';
    try { await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { timeout: 20000 }); }
    catch (e) { throw new Problem('Could not open Windows voice typing. Press the Windows key and H together instead.'); }
    return { ok: true };
  }

  // ---------- the board ----------
  // Sticky notes for the start screen, kept with the chats (ROOT\.folder-map\board.json).
  // Folder tags are saved relative to the root, so the board still works if the root moves.
  const boardFile = () => path.join(WORKSPACE, STORE, 'board.json');
  async function boardGet() {
    if (!WORKSPACE) return { notes: [] };
    try { const b = JSON.parse(await fsp.readFile(boardFile(), 'utf8')); return { notes: Array.isArray(b.notes) ? b.notes : [] }; }
    catch (e) { return { notes: [] }; }
  }
  const num = (v, lo, hi) => Math.max(lo, Math.min(hi, Number(v) || 0));
  async function boardSave({ notes }) {
    if (!WORKSPACE) throw new Problem('Choose a root folder first.');
    const clean = (Array.isArray(notes) ? notes : []).slice(0, 400).map(n => ({
      id: goodId(n && n.id) ? n.id : Math.random().toString(36).slice(2, 12),
      x: num(n.x, 0, 20000), y: num(n.y, 0, 20000), c: num(n.c, 0, 20), r: num(n.r, -6, 6), z: num(n.z, 0, 1e9), at: Number(n.at) || Date.now(),
      parts: (Array.isArray(n.parts) ? n.parts : []).slice(0, 80).map(part => {
        if (part && typeof part.p === 'string') {
          const rel = part.p.replace(/\\/g, '/').split('/').filter(x => x && x !== '.' && x !== '..').join('/').slice(0, 400);
          return { p: rel };
        }
        return { t: String((part && part.t) || '').slice(0, 4000) };
      }),
    }));
    await fsp.mkdir(path.join(WORKSPACE, STORE), { recursive: true });
    const file = boardFile(), tmp = file + '.' + process.pid + '.tmp';
    await fsp.writeFile(tmp, JSON.stringify({ notes: clean }, null, 1));
    await fsp.rename(tmp, file);
    return { ok: true };
  }

  return { root: () => WORKSPACE, setRoot, preview, chatsList, chatSave, chatDelete, boardGet, boardSave, zip, props, dictate, check, ls, drives: ({ force } = {}) => getDrives(force), search, copy, remove, rename, mkdir, print,
    startIndexing, TRASH, home: () => ({ home: WORKSPACE }) };
}

module.exports = { create, Problem };
