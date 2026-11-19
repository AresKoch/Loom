// Loom: desktop app window. All disk work is in backend.js, Claude is in claude.js.
const { app, BrowserWindow, ipcMain, shell, nativeImage, Menu, dialog } = require('electron');
const path = require('path');
const { spawn, execFile } = require('child_process');
const fs = require('fs');
const { create, Problem } = require('./backend');
const claudeLib = require('./claude');
const gitLib = require('./git');
const syncLib = require('./sync');

if (process.env.FOLDERMAP_SHOT) {
  // Build self check runs beside a copy that may already be open, with its own scratch profile.
  app.setPath('userData', path.join(app.getPath('temp'), 'foldermap-selfcheck'));
} else {
  // The app was called Folder Map before 1.3.0. Settings stay in that folder so the root folder, theme and layout carry over.
  app.setPath('userData', path.join(app.getPath('appData'), 'Folder Map'));
  if (!app.requestSingleInstanceLock()) { app.quit(); return; }
}

let win = null;
let backend = null;

// ---------- settings kept on this PC: the chosen root folder and recent ones ----------
const settingsFile = () => path.join(app.getPath('userData'), 'folder-map.json');
let settings = { root: null, recents: [], look: null };
function loadSettings() {
  try { const s = JSON.parse(fs.readFileSync(settingsFile(), 'utf8')); settings = { root: s.root || null, recents: Array.isArray(s.recents) ? s.recents : [], look: goodLook(s.look) }; }
  catch (e) { /* first run */ }
}
function saveSettings() {
  try { fs.mkdirSync(path.dirname(settingsFile()), { recursive: true }); fs.writeFileSync(settingsFile(), JSON.stringify(settings, null, 2)); }
  catch (e) { /* not fatal */ }
}
// The window frame colours of the chosen theme, kept so the next start opens in the right colours straight away.
const HEX = /^#[0-9a-fA-F]{6}$/;
function goodLook(l) { return l && HEX.test(l.bg) && HEX.test(l.fg) ? { bg: l.bg, fg: l.fg } : null; }
const isDir = p => { try { return !!p && fs.statSync(p).isDirectory(); } catch (e) { return false; } };

// Which folder to open at start: the test override, the last one chosen here, or an optional
// default from a config.json placed next to the .exe:  { "workspace": "D:\\Some\\Folder" }
function startRoot() {
  const tries = [process.env.FOLDERMAP_WORKSPACE, settings.root];
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(path.dirname(app.getPath('exe')), 'config.json'), 'utf8'));
    if (cfg.workspace) tries.push(cfg.workspace);
  } catch (e) { /* no config, fine */ }
  return tries.find(isDir) || null;
}
function rootInfo() { return { root: backend.root(), recents: settings.recents.filter(p => p !== backend.root()).slice(0, 8) }; }
async function useRoot(p) {
  const before = backend.root();
  await backend.setRoot({ path: p });
  const r = backend.root();
  try { await backend.adoptChats({ into: r, from: [before, ...settings.recents] }); } catch (e) { /* chats stay where they were */ }
  settings.root = r;
  settings.recents = [r, ...settings.recents.filter(x => x.toLowerCase() !== r.toLowerCase())].slice(0, 10);
  saveSettings();
  return rootInfo();
}

// Small tile shown under the cursor while dragging files out of the app.
function dragIcon() {
  const n = 40, buf = Buffer.alloc(n * n * 4);
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    const i = (y * n + x) * 4, edge = x < 2 || y < 2 || x >= n - 2 || y >= n - 2;
    buf[i] = edge ? 0x50 : 0xd3; buf[i + 1] = edge ? 0x84 : 0xe3; buf[i + 2] = edge ? 0xcc : 0xeb; buf[i + 3] = 0xff; // BGRA
  }
  return nativeImage.createFromBitmap(buf, { width: n, height: n });
}

function createWindow() {
  win = new BrowserWindow({
    width: 1500, height: 950, minWidth: 900, minHeight: 600,
    title: 'Loom', icon: path.join(__dirname, 'icon.png'), backgroundColor: (settings.look || {}).bg || '#0d0d0c', autoHideMenuBar: true, show: false,
    titleBarStyle: 'hidden', titleBarOverlay: { color: (settings.look || {}).bg || '#0d0d0c', symbolColor: (settings.look || {}).fg || '#ebe3d3', height: 44 },
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: false, plugins: true },
  });
  Menu.setApplicationMenu(null);
  win.loadFile(path.join(__dirname, 'app.html'));
  win.once('ready-to-show', () => { if (!process.env.FOLDERMAP_SHOT) win.maximize(); win.show(); });
  win.webContents.on('will-navigate', e => e.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  // Self check used by the build: save a picture of the window and quit.
  if (process.env.FOLDERMAP_SHOT) {
    win.webContents.once('did-finish-load', () => setTimeout(async () => {
      const js = code => win.webContents.executeJavaScript(code);
      try {
        if (process.env.FOLDERMAP_JS) await js(process.env.FOLDERMAP_JS);     // set the scene for the picture
        // Optional: also ask Claude one read only question, to prove the panel works inside the .exe.
        if (process.env.FOLDERMAP_ASK) {
          await js(`newChat(); S.mode = 'look'; setView('split'); $('cin').value = ${JSON.stringify(process.env.FOLDERMAP_ASK)}; cSend(); true`);
          for (let i = 0; i < 180; i++) {
            await new Promise(r => setTimeout(r, 500));
            if (!(await js('C.busy'))) break;
          }
        }
        await new Promise(r => setTimeout(r, 1800));
        fs.writeFileSync(process.env.FOLDERMAP_SHOT, (await win.webContents.capturePage()).toPNG());
      }
      finally { app.quit(); }
    }, 2500));
  }
}

app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
app.on('window-all-closed', () => app.quit());

app.whenReady().then(() => {
  loadSettings();
  backend = create({ workspace: startRoot(), fakeUsb: process.env.FOLDERMAP_FAKE_USB || null });
  backend.startIndexing();
  if (backend.root()) backend.adoptChats({ into: backend.root(), from: settings.recents }).catch(() => {});   // chats left in a deeper or higher root come along

  const git = gitLib.create({ check: p => backend.check(p), root: () => backend.root(), Problem });
  const sync = syncLib.create({ root: () => backend.root(), Problem });
  const actions = {
    // GIT tab. Every repository path is checked to be inside the root folder (see git.js).
    gitRepos: () => git.repos(),
    gitStatus: a => git.status(a),
    gitDiff: a => git.diff(a),
    gitLog: a => git.log(a),
    gitCommitFiles: a => git.commitFiles(a),
    gitCommit: a => git.commit(a),
    gitBranches: a => git.branches(a),
    gitCheckout: a => git.checkout(a),
    gitBranchNew: a => git.branchNew(a),
    gitSync: a => git.sync(a),
    // Discard one file's changes. The current copy goes to the app trash first, so nothing is destroyed.
    gitDiscard: async a => {
      const rp = git.repoPath(a.repo), ap = git.filePath(rp, a.file);
      let trash = null;
      if (fs.existsSync(ap)) trash = (await backend.remove({ paths: [ap] })).trash;
      await git.restore(a);
      return { trash };
    },
    gitWeb: async a => {
      const st = await git.status(a);
      if (!st.web) throw new Problem('This repository has no GitHub page set as its origin.');
      await shell.openExternal(st.web);
      return { ok: true };
    },
    home: () => backend.home(),
    ls: a => backend.ls(a),
    drives: a => backend.drives(a),
    search: a => backend.search(a),
    copy: a => backend.copy(a),
    remove: a => backend.remove(a),
    rename: a => backend.rename(a),
    mkdir: a => backend.mkdir(a),
    print: a => backend.print(a),
    preview: a => backend.preview(a),
    chatsList: a => backend.chatsList(a),
    chatSave: a => backend.chatSave(a),
    chatDelete: a => backend.chatDelete(a),
    boardGet: a => backend.boardGet(a),
    boardSave: a => backend.boardSave(a),
    zip: a => backend.zip(a),
    // Sync: the written handoff between this PC and the phone (see sync.js).
    syncStatus: () => sync.status(),
    syncSetup: a => sync.setup(a),
    syncRun: () => sync.run(),
    syncProgress: () => sync.progress(),
    syncWeb: async () => { const s = await sync.status(); if (s.url && /^https:\/\/github\.com\//.test(s.url)) await shell.openExternal(s.url.replace(/\.git$/, '')); return { ok: true }; },
    syncLatest: async () => { const f = path.join(sync.dir(), 'LATEST.md'); return { text: fs.existsSync(f) ? fs.readFileSync(f, 'utf8').slice(0, 60000) : '' }; },
    dictate: () => backend.dictate(),
    appInfo: () => ({ version: app.getVersion() }),
    openRepo: async () => { await shell.openExternal('https://github.com/AresKoch/Loom/releases'); return { ok: true }; },
    props: a => backend.props(a),
    // A picture of the file from Windows itself: the same thumbnail Explorer shows
    // (SolidWorks parts, drawings, images, Office files with a saved preview).
    thumb: async ({ path: p, size }) => {
      const ap = backend.check(p), n = Math.max(64, Math.min(640, Number(size) || 360));
      try {
        const img = await nativeImage.createThumbnailFromPath(ap, { width: n, height: n });
        if (img.isEmpty()) return { dataUrl: null };
        return { dataUrl: img.toDataURL() };
      } catch (e) { return { dataUrl: null }; }
    },
    open: async ({ path: p }) => {
      const err = await shell.openPath(backend.check(p));
      if (err) throw new Problem('Windows could not open that: ' + err);
      return { ok: true };
    },
    reveal: async ({ path: p }) => {
      const ap = backend.check(p);
      if (fs.statSync(ap).isDirectory()) await shell.openPath(ap); else shell.showItemInFolder(ap);
      return { ok: true };
    },
  };

  ipcMain.handle('call', async (event, name, arg) => {
    if (!Object.prototype.hasOwnProperty.call(actions, name)) return { ok: false, error: 'Unknown action.' };
    try { return { ok: true, data: await actions[name](arg || {}) }; }
    catch (e) {
      if (e instanceof Problem) return { ok: false, error: e.message };
      if (e && (e.code === 'EPERM' || e.code === 'EBUSY' || e.code === 'EACCES')) return { ok: false, error: 'Windows would not allow that (file in use or no permission).' };
      return { ok: false, error: 'Could not do that: ' + (e && e.message ? e.message : e) };
    }
  });

  // Theme: the window passes its frame colours so the title bar buttons match.
  ipcMain.on('look', (event, l) => {
    const look = goodLook(l); if (!look || !win) return;
    try { win.setTitleBarOverlay({ color: look.bg, symbolColor: look.fg, height: 44 }); win.setBackgroundColor(look.bg); } catch (e) { /* older Windows */ }
    settings.look = look; saveSettings();
  });

  // Root folder: any folder on this PC or the network, picked by the person using the app.
  ipcMain.handle('root:get', () => rootInfo());
  ipcMain.handle('root:set', async (event, p) => {
    try { return await useRoot(String(p || '')); } catch (e) { return { error: e.message, ...rootInfo() }; }
  });
  ipcMain.handle('root:choose', async () => {
    const r = await dialog.showOpenDialog(win, { title: 'Choose the root folder', properties: ['openDirectory'],
      defaultPath: backend.root() || app.getPath('documents') });
    if (r.canceled || !r.filePaths[0]) return { canceled: true, ...rootInfo() };
    try { return await useRoot(r.filePaths[0]); } catch (e) { return { error: e.message, ...rootInfo() }; }
  });

  // Claude: replies stream back to the window as they are written.
  const claude = claudeLib.create({ getRoot: () => backend.root() });
  ipcMain.handle('claude:status', () => claude.status());
  ipcMain.handle('claude:stop', (e, id) => claude.stop(typeof id === 'string' ? id : null));
  ipcMain.handle('claude:login', () => claude.login());
  ipcMain.handle('claude:remote', () => claude.remote());
  ipcMain.on('claude:send', (event, msg) => {
    msg = msg || {};
    const chatId = typeof msg.chatId === 'string' ? msg.chatId.slice(0, 40) : null;
    const out = ev => { if (!event.sender.isDestroyed()) event.sender.send('claude:event', { ...ev, chatId }); };
    let folder = null, selected = [];
    try { folder = msg.folder ? backend.check(msg.folder) : null; } catch (e) { /* outside: leave out */ }
    for (const p of Array.isArray(msg.selected) ? msg.selected : []) { try { selected.push(backend.check(p)); } catch (e) { /* skip */ } }
    claude.send({ chatId, prompt: String(msg.prompt || ''), sessionId: typeof msg.sessionId === 'string' ? msg.sessionId : null,
      mode: msg.mode, model: msg.model, effort: msg.effort, folder, selected,
      history: typeof msg.history === 'string' ? msg.history.slice(0, 40000) : null }, out);
  });
  app.on('before-quit', () => claude.stop());

  // ---------- terminal drawer ----------
  // Runs one command line at a time in a folder, through the normal Windows command shell, and streams what it
  // prints back to the window. Typed lines go to the running program. It is not a full console: programs that
  // draw a screen (editors, menus) will not work, but npm, git, python and the like do.
  let termKid = null;
  const termKill = () => { const k = termKid; if (!k) return; k.stopped = true;
    if (process.platform === 'win32') execFile('taskkill', ['/pid', String(k.pid), '/T', '/F'], { windowsHide: true }, () => {});
    else { try { process.kill(-k.pid); } catch (e) { try { k.kill(); } catch (e2) { /* gone */ } } } };
  ipcMain.handle('term:cd', (e, a) => {
    a = a || {}; const base = isDir(a.cwd) ? a.cwd : backend.root() || process.cwd();
    let to = String(a.to || '').trim().replace(/^\/d\s+/i, '').replace(/^"(.*)"$/, '$1');
    if (!to || to === '~') to = require('os').homedir();
    const p = path.resolve(base, to);
    return isDir(p) ? { cwd: p } : { error: 'There is no folder ' + p };
  });
  ipcMain.on('term:run', (event, a) => {
    const out = ev => { if (!event.sender.isDestroyed()) event.sender.send('term:event', ev); };
    a = a || {}; const cmd = String(a.cmd || '').slice(0, 8000), cwd = isDir(a.cwd) ? a.cwd : backend.root();
    if (termKid) return out({ t: 'exit', error: 'Something is still running. Stop it first.' });
    if (!cmd.trim() || !cwd) return out({ t: 'exit', code: 0 });
    const win = process.platform === 'win32';
    const env = { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0', TERM: 'dumb' }; delete env.ELECTRON_RUN_AS_NODE;
    let kid;
    try { kid = spawn(win ? 'chcp 65001>nul & ' + cmd : cmd, { cwd, shell: true, windowsHide: true, env, detached: !win, stdio: ['pipe', 'pipe', 'pipe'] }); }
    catch (e) { return out({ t: 'exit', error: e.message }); }
    termKid = kid;
    for (const s of [kid.stdout, kid.stderr]) { s.setEncoding('utf8'); s.on('data', d => out({ t: 'out', text: d })); }
    kid.stdin.on('error', () => {});
    kid.on('error', e => { if (termKid === kid) termKid = null; out({ t: 'exit', error: e.message }); });
    kid.on('close', code => { if (termKid === kid) termKid = null; out({ t: 'exit', code, stopped: !!kid.stopped }); });
  });
  ipcMain.on('term:in', (e, text) => { if (termKid) { try { termKid.stdin.write(String(text)); } catch (e2) { /* closed */ } } });
  ipcMain.handle('term:stop', () => { termKill(); return { ok: true }; });
  app.on('before-quit', termKill);

  // Real Windows drag: lets files be dropped on Explorer, the desktop, or a USB window too.
  ipcMain.on('drag', (event, paths) => {
    if (!Array.isArray(paths) || !paths.length) return;
    try {
      const files = paths.map(p => backend.check(p)).filter(p => fs.existsSync(p));
      if (files.length) event.sender.startDrag({ files, file: files[0], icon: dragIcon() });
    } catch (e) { /* ignore a bad drag */ }
  });

  createWindow();
});
