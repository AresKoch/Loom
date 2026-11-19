// The app dock: the programs installed on this PC, read from the Windows Start menu, so Loom can
// start them the way the taskbar does. Nothing here runs a path the window sends: an app can only
// be started by the id Windows itself listed for it.
const fs = require('fs');
const path = require('path');
const { execFile, spawn } = require('child_process');

const DULL = /uninstall|^readme|release notes|documentation|website|\bhelp\b|license|^about /i;

function create({ Problem, getFileIcon, readShortcut, nativeImage, custom = () => [], openPath }) {
  let cache = null, at = 0, links = null;

  // Every Start menu shortcut by name, for looking up an app's icon.
  function startLinks() {
    if (links) return links;
    links = new Map();
    const roots = [path.join(process.env.ProgramData || 'C:\\ProgramData', 'Microsoft', 'Windows', 'Start Menu', 'Programs'),
      path.join(process.env.APPDATA || '', 'Microsoft', 'Windows', 'Start Menu', 'Programs')];
    const walk = (dir, depth) => {
      let names = []; try { names = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
      for (const n of names) {
        const full = path.join(dir, n.name);
        if (n.isDirectory()) { if (depth < 4) walk(full, depth + 1); }
        else if (/\.lnk$/i.test(n.name)) { const k = n.name.slice(0, -4).toLowerCase(); if (!links.has(k)) links.set(k, full); }
      }
    };
    for (const r of roots) walk(r, 0);
    return links;
  }

  // Programs added by hand come first in the list, marked so they can be told apart.
  const mine = () => custom().map(a => ({ id: 'file:' + a.path, name: a.name, file: a.path, added: true }));
  async function list(o) { const r = await listStart(o); return { apps: [...mine(), ...r.apps] }; }
  function listStart({ fresh } = {}) {
    if (process.env.LOOM_FAKE_APPS) { try { cache = JSON.parse(process.env.LOOM_FAKE_APPS); } catch (e) { cache = []; } return Promise.resolve({ apps: cache }); }
    if (process.platform !== 'win32') return Promise.resolve({ apps: [] });
    if (cache && !fresh && Date.now() - at < 300000) return Promise.resolve({ apps: cache });
    return new Promise(resolve => {
      execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '[Console]::OutputEncoding=[Text.Encoding]::UTF8; Get-StartApps | Select-Object Name,AppID | ConvertTo-Json -Compress'],
        { windowsHide: true, timeout: 20000, maxBuffer: 8 << 20 }, (err, out) => {
          let rows = []; try { rows = JSON.parse(out); if (!Array.isArray(rows)) rows = [rows]; } catch (e) { rows = []; }
          const seen = new Set(), apps = [];
          for (const r of rows) {
            const name = String((r && r.Name) || '').trim(), id = String((r && r.AppID) || '').trim();
            if (!name || !id || DULL.test(name) || /^https?:/i.test(id) || seen.has(id)) continue;
            seen.add(id); apps.push({ id, name });
          }
          apps.sort((a, b) => a.name.localeCompare(b.name));
          if (apps.length || !cache) { cache = apps; at = Date.now(); links = null; }
          resolve({ apps: cache });
        });
    });
  }

  async function launch({ id }) {
    const apps = (await list()).apps, hit = apps.find(a => a.id === id);
    if (!hit) throw new Problem('That app is not in the Start menu any more.');
    if (hit.file) { const err = await openPath(hit.file); if (err) throw new Problem('Could not open ' + hit.name + ': ' + err); return { ok: true, name: hit.name }; }
    if (process.platform !== 'win32') return { ok: true, name: hit.name };
    spawn('explorer.exe', ['shell:AppsFolder\\' + hit.id], { detached: true, stdio: 'ignore', windowsHide: false }).unref();
    return { ok: true, name: hit.name };
  }

  // Where Windows keeps things, for app ids that start with a known-folder code.
  const KNOWN = {
    '{6D809377-6AF0-444B-8957-A3773F02200E}': process.env.ProgramW6432 || process.env.ProgramFiles || 'C:\\Program Files',
    '{7C5A40EF-A0FB-4BFC-874A-C0F2E0B9FA8E}': process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)',
    '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}': path.join(process.env.SystemRoot || 'C:\\Windows', 'System32'),
    '{D65231B0-B2F1-4857-A4CE-A8E7C6EA7D27}': path.join(process.env.SystemRoot || 'C:\\Windows', 'SysWOW64'),
    '{F38BF404-1D43-42F2-9305-67DE0B28FC23}': process.env.SystemRoot || 'C:\\Windows',
  };
  const isFile = f => { try { return !!f && fs.statSync(f).isFile(); } catch (e) { return false; } };
  const expand = s => String(s || '').replace(/%([^%]+)%/g, (m, k) => process.env[k] || m);
  async function picture(file) {
    if (!isFile(file)) return null;
    try {
      if (/\.(ico|png)$/i.test(file)) { const im = nativeImage.createFromPath(file); if (!im.isEmpty()) return im.resize({ width: 64, height: 64, quality: 'best' }).toDataURL(); }
      const img = await getFileIcon(file, { size: 'large' }); return img.isEmpty() ? null : img.toDataURL();
    } catch (e) { return null; }
  }
  // A Store app keeps its logo inside its package: ask Windows where the package is and which logo it names.
  function storeLogo(id) {
    return new Promise(resolve => {
      const [fam, appId] = id.split('!');
      if (!/^[\w.-]+_[a-z0-9]+$/i.test(fam || '')) return resolve(null);
      const ps = "$p = Get-AppxPackage | Where-Object { $_.PackageFamilyName -eq '" + fam + "' } | Select-Object -First 1; if ($p) { $m = [xml](Get-Content -LiteralPath (Join-Path $p.InstallLocation 'AppxManifest.xml')); "
        + "$a = @($m.Package.Applications.Application) | Where-Object { $_.Id -eq '" + String(appId || '').replace(/[^\w.-]/g, '') + "' } | Select-Object -First 1; if (-not $a) { $a = @($m.Package.Applications.Application)[0] }; "
        + "@{ dir = $p.InstallLocation; logo = $a.VisualElements.Square44x44Logo } | ConvertTo-Json -Compress }";
      execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { windowsHide: true, timeout: 20000 }, (err, out) => {
        try {
          const r = JSON.parse(out); if (!r.dir || !r.logo) return resolve(null);
          const full = path.join(r.dir, r.logo), dir = path.dirname(full), stem = path.basename(full, path.extname(full)).toLowerCase();
          const all = fs.readdirSync(dir).filter(n => n.toLowerCase().startsWith(stem) && /\.png$/i.test(n));
          const score = n => { n = n.toLowerCase(); const t = /targetsize-(\d+)/.exec(n), s = /scale-(\d+)/.exec(n);
            return (n.includes('unplated') ? 1000 : 0) + (n.includes('contrast') ? -5000 : 0) + (t ? 500 - Math.abs(+t[1] - 64) : s ? +s[1] : 1); };
          all.sort((a, b) => score(b) - score(a));
          resolve(all.length ? path.join(dir, all[0]) : (isFile(full) ? full : null));
        } catch (e) { resolve(null); }
      });
    });
  }

  // The app's own picture. A shortcut is followed to the program (or the icon file) it points at, a Store
  // app's logo is read from its package, and a plain program path gives its own icon.
  async function icon({ id }) {
    const apps = (await list()).apps, hit = apps.find(a => a.id === id);
    if (!hit || process.platform !== 'win32') return { dataUrl: null };
    const tries = [];
    if (hit.file) { if (/\.lnk$/i.test(hit.file)) { try { const s = readShortcut(hit.file); if (s.icon) tries.push(expand(s.icon)); if (s.target) tries.push(expand(s.target)); } catch (e) { /* plain file */ } } else tries.push(hit.file); }
    const lnk = hit.file ? null : startLinks().get(hit.name.toLowerCase());
    if (lnk) { try { const s = readShortcut(lnk); if (s.icon) tries.push(expand(s.icon)); if (s.target) tries.push(expand(s.target)); } catch (e) { /* not a plain shortcut */ } }
    const kf = /^(\{[0-9A-F-]{36}\})\\(.+)$/i.exec(hit.id);
    if (kf && KNOWN[kf[1].toUpperCase()]) tries.push(path.join(KNOWN[kf[1].toUpperCase()], kf[2]));
    if (path.isAbsolute(hit.id)) tries.push(hit.id);
    if (/explorer/i.test(hit.id)) tries.push(path.join(process.env.SystemRoot || 'C:\\Windows', 'explorer.exe'));
    for (const t of tries) { if (/\.(exe|ico|png|dll)$/i.test(t)) { const u = await picture(t); if (u) return { dataUrl: u }; } }
    if (hit.id.includes('!')) { const logo = await storeLogo(hit.id); const u = logo && await picture(logo); if (u) return { dataUrl: u }; }
    return { dataUrl: null };
  }

  // ---------- what is open right now ----------
  // One quiet PowerShell stays running and reports, every couple of seconds, each program that has a window.
  // (Windows reports one window per program this way, so two windows of one app show as one.)
  let watcher = null, wins = [], winsKey = '';
  const HIDE = new Set(['textinputhost', 'shellexperiencehost', 'searchhost', 'startmenuexperiencehost', 'lockapp']);
  function take(rows, cb) {
    const list = (Array.isArray(rows) ? rows : [rows]).filter(r => r && r.Id && r.Id !== process.pid && !HIDE.has(String(r.ProcessName || '').toLowerCase()))
      .map(r => ({ pid: r.Id, proc: String(r.ProcessName || ''), title: String(r.MainWindowTitle || '').slice(0, 200), path: r.Path ? String(r.Path) : null }))
      .sort((a, b) => a.proc.localeCompare(b.proc) || a.pid - b.pid);
    const key = JSON.stringify(list.map(w => [w.pid, w.title]));
    wins = list; if (key !== winsKey) { winsKey = key; cb(list); }
  }
  function watch(cb) {
    if (process.env.LOOM_FAKE_WINS) { try { take(JSON.parse(process.env.LOOM_FAKE_WINS), cb); } catch (e) { /* none */ } return; }
    if (process.platform !== 'win32' || watcher) return;
    const script = "$ErrorActionPreference='SilentlyContinue'; [Console]::OutputEncoding=[Text.Encoding]::UTF8; while($true){ $r=@(Get-Process | Where-Object { $_.MainWindowTitle -and $_.MainWindowHandle -ne 0 } | Select-Object Id,ProcessName,MainWindowTitle,Path); ConvertTo-Json -Compress -InputObject $r; Start-Sleep -Milliseconds 2500 }";
    watcher = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    let buf = '';
    watcher.stdout.setEncoding('utf8');
    watcher.stdout.on('data', d => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (l) { try { take(JSON.parse(l), cb); } catch (e) { /* half a line */ } } } });
    watcher.on('error', () => { watcher = null; });
    watcher.on('close', () => { watcher = null; });
  }
  function unwatch() { if (watcher) { try { watcher.kill(); } catch (e) { /* gone */ } watcher = null; } }
  // Bring a program's window to the front (and un-minimise it). Only for a program the watcher reported.
  function focus({ pid }) {
    const w = wins.find(x => x.pid === pid);
    if (!w) throw new Problem('That window is not open any more.');
    if (process.platform !== 'win32') return Promise.resolve({ ok: true });
    const ps = "Add-Type -Namespace LoomF -Name W -MemberDefinition '[DllImport(\"user32.dll\")] public static extern bool SetForegroundWindow(System.IntPtr h); [DllImport(\"user32.dll\")] public static extern bool ShowWindowAsync(System.IntPtr h, int c); [DllImport(\"user32.dll\")] public static extern bool IsIconic(System.IntPtr h);'; "
      + '$h = (Get-Process -Id ' + Number(pid) + ').MainWindowHandle; if ([LoomF.W]::IsIconic($h)) { [void][LoomF.W]::ShowWindowAsync($h, 9) }; [void][LoomF.W]::SetForegroundWindow($h)';
    return new Promise(resolve => execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { windowsHide: true, timeout: 15000 }, () => resolve({ ok: true })));
  }
  async function winIcon({ pid }) { const w = wins.find(x => x.pid === pid); return { dataUrl: w && w.path ? await picture(w.path) : null }; }

  // Open a folder or file in VS Code, started directly (no command line is built from the path).
  function vscode({ target }) {
    const tries = [path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Microsoft VS Code', 'Code.exe'),
      path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Microsoft VS Code', 'Code.exe'),
      path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Microsoft VS Code', 'Code.exe')];
    const exe = tries.find(t => { try { return fs.statSync(t).isFile(); } catch (e) { return false; } });
    if (!exe) throw new Problem('VS Code was not found on this PC.');
    spawn(exe, [target], { detached: true, stdio: 'ignore' }).unref();
    return { ok: true };
  }

  return { list, launch, icon, vscode, watch, unwatch, focus, winIcon, windows: () => wins };
}

module.exports = { create };
