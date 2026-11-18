// Git for Loom: the GIT tab. Runs the git program already on this PC.
// It looks for Git for Windows first, then the copy that ships inside GitHub Desktop.
// It only works on repositories inside the root folder. Nothing here stores a password or token:
// sign in is whatever git on this PC already uses (Git Credential Manager, or a token in the remote URL).
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { execFile } = require('child_process');

const SKIP = new Set(['node_modules', '.git', '__pycache__', '.venv', 'venv', 'build', 'dist', '.folder-map', '.folder-map-trash',
  'System Volume Information', '$RECYCLE.BIN']);
const MAX_OUT = 600 * 1024;      // most diff text sent to the window

function newestDesktopGit() {
  const base = path.join(process.env.LOCALAPPDATA || '', 'GitHubDesktop');
  let best = null;
  try {
    for (const d of fs.readdirSync(base)) {
      if (!d.startsWith('app-')) continue;
      const exe = path.join(base, d, 'resources', 'app', 'git', 'cmd', 'git.exe');
      try {
        if (!fs.statSync(exe).isFile()) continue;
        const key = d.slice(4).split('.').map(n => String(n).padStart(6, '0')).join('.');
        if (!best || key > best.key) best = { exe, key };
      } catch (e) { /* not a build folder */ }
    }
  } catch (e) { /* GitHub Desktop not installed */ }
  return best && best.exe;
}
function findGit() {
  const pf = process.env.ProgramFiles || 'C:\\Program Files', pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  const tries = [process.env.FOLDERMAP_GIT,
    path.join(pf, 'Git', 'cmd', 'git.exe'), path.join(pf86, 'Git', 'cmd', 'git.exe'),
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Git', 'cmd', 'git.exe'),
    newestDesktopGit()];
  for (const t of tries) { try { if (t && fs.statSync(t).isFile()) return t; } catch (e) { /* next */ } }
  return process.platform === 'win32' ? null : 'git';   // elsewhere (tests) use the one on PATH
}

// Never let a token that sits in a remote URL reach the window.
const scrub = s => String(s || '').replace(/(https?:\/\/)[^@\/\s]+@/g, '$1');

function create({ check, root, Problem }) {
  let GIT;
  const git = () => (GIT === undefined ? (GIT = findGit()) : GIT);

  function run(repo, args, opts) {
    opts = opts || {};
    return new Promise((resolve, reject) => {
      const exe = git();
      if (!exe) return reject(new Problem('Git was not found on this PC. Install Git for Windows or GitHub Desktop.'));
      const env = { ...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C', LANG: 'C' };
      if (!opts.write) env.GIT_OPTIONAL_LOCKS = '0';
      const child = execFile(exe, ['-c', 'core.quotepath=false', '-c', 'color.ui=false', ...args],
        { cwd: repo, windowsHide: true, maxBuffer: 64 * 1024 * 1024, timeout: opts.timeout || 30000, env, encoding: 'utf8' },
        (err, out, errOut) => {
          if (err && !opts.ok) {
            const msg = scrub((errOut || '').trim() || (out || '').trim() || err.message).split('\n').filter(Boolean).slice(-6).join('\n');
            return reject(new Problem(err.killed ? 'Git took too long and was stopped.' : msg));
          }
          resolve({ out: out || '', err: scrub(errOut || ''), code: err ? (err.code || 1) : 0 });
        });
      if (opts.input != null) { child.stdin.end(opts.input); }
    });
  }

  // A repository must sit inside the root folder, and a file must sit inside its repository.
  function repoPath(p) {
    const ap = check(p);
    if (!fs.existsSync(path.join(ap, '.git'))) throw new Problem('That folder is not a git repository.');
    return ap;
  }
  function filePath(repo, rel) {
    if (typeof rel !== 'string' || !rel) throw new Problem('No file given.');
    const ap = path.resolve(repo, rel), r = path.resolve(repo);
    if (ap !== r && !ap.toLowerCase().startsWith(r.toLowerCase() + path.sep)) throw new Problem('That file is outside the repository.');
    return ap;
  }
  const goodSha = s => typeof s === 'string' && /^[0-9a-f]{7,40}$/.test(s);

  // ---------- which repositories are under the root folder ----------
  async function repos() {
    const top = root();
    if (!top) return { repos: [], git: !!git() };
    const found = [];
    const walk = async (dir, depth) => {
      if (found.length >= 80) return;
      let ents;
      try { ents = await fsp.readdir(dir, { withFileTypes: true }); } catch (e) { return; }
      if (ents.some(e => e.name === '.git')) { found.push(dir); return; }      // do not look for repositories inside a repository
      if (depth >= 4) return;
      for (const e of ents) if (e.isDirectory() && !SKIP.has(e.name) && !e.name.startsWith('.')) await walk(path.join(dir, e.name), depth + 1);
    };
    await walk(top, 0);
    found.sort((a, b) => path.basename(a).localeCompare(path.basename(b), undefined, { sensitivity: 'base' }));
    return { git: !!git(), repos: found.map(p => ({ path: p, name: path.basename(p), where: path.relative(top, path.dirname(p)) })) };
  }

  // ---------- what changed ----------
  function parseStatus(text) {
    const st = { branch: null, upstream: null, ahead: 0, behind: 0, detached: false, files: [] };
    const recs = text.split('\0');
    for (let i = 0; i < recs.length; i++) {
      const r = recs[i]; if (!r) continue;
      if (r.startsWith('# branch.head ')) { st.branch = r.slice(14); if (st.branch === '(detached)') st.detached = true; }
      else if (r.startsWith('# branch.upstream ')) st.upstream = r.slice(18);
      else if (r.startsWith('# branch.ab ')) { const m = /\+(\d+) -(\d+)/.exec(r); if (m) { st.ahead = +m[1]; st.behind = +m[2]; } }
      else if (r[0] === '1') { const f = r.split(' '); st.files.push(kindOf(f[1], f.slice(8).join(' '))); }
      else if (r[0] === '2') { const f = r.split(' '); const it = kindOf(f[1], f.slice(9).join(' ')); it.orig = recs[++i]; it.kind = 'R'; st.files.push(it); }
      else if (r[0] === 'u') { const f = r.split(' '); st.files.push({ path: f.slice(10).join(' '), kind: 'U' }); }
      else if (r[0] === '?') st.files.push({ path: r.slice(2), kind: '?' });
    }
    st.files.sort((a, b) => a.path.localeCompare(b.path, undefined, { sensitivity: 'base' }));
    return st;
  }
  function kindOf(xy, p) {
    const k = xy.includes('D') ? 'D' : xy.includes('A') ? 'A' : xy.includes('R') ? 'R' : 'M';
    return { path: p, kind: k };
  }
  async function status({ repo }) {
    const rp = repoPath(repo);
    const r = await run(rp, ['status', '--porcelain=v2', '--branch', '-z', '--untracked-files=all']);
    const st = parseStatus(r.out);
    let remote = null;
    try { remote = webUrl((await run(rp, ['remote', 'get-url', 'origin'])).out.trim()); } catch (e) { /* no remote */ }
    return { ...st, repo: rp, hasRemote: remote !== null || await hasRemote(rp), web: remote };
  }
  async function hasRemote(rp) { try { return !!(await run(rp, ['remote'])).out.trim(); } catch (e) { return false; } }
  // The page for this repository on github.com, with any sign in details removed. null when it is not GitHub.
  function webUrl(u) {
    u = scrub(u).trim();
    let m = /^https?:\/\/github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(u) || /^git@github\.com:([\w.-]+)\/([\w.-]+?)(?:\.git)?$/.exec(u);
    return m ? `https://github.com/${m[1]}/${m[2]}` : null;
  }

  // ---------- the text of a change ----------
  const clip = s => (s.length > MAX_OUT ? { text: s.slice(0, MAX_OUT), cut: true } : { text: s, cut: false });
  async function wholeFile(ap, sign) {
    let buf;
    try { const st = await fsp.stat(ap); if (st.isDirectory()) return { text: '', note: 'A folder.' }; if (st.size > 2 * 1024 * 1024) return { text: '', note: 'Large new file (' + Math.round(st.size / 1024) + ' KB). Not shown.' }; buf = await fsp.readFile(ap); }
    catch (e) { return { text: '', note: 'That file is not there any more.' }; }
    if (buf.subarray(0, 8000).includes(0)) return { text: '', note: 'Binary file. Not shown.' };
    const lines = buf.toString('utf8').replace(/\r/g, '').split('\n');
    if (lines[lines.length - 1] === '') lines.pop();
    return clip('@@ new file, ' + lines.length + ' lines @@\n' + lines.map(l => sign + l).join('\n'));
  }
  async function diff({ repo, file, sha, kind }) {
    const rp = repoPath(repo); const ap = filePath(rp, file);
    const rel = path.relative(rp, ap).split(path.sep).join('/');
    if (sha) {
      if (!goodSha(sha)) throw new Problem('Bad commit.');
      const r = await run(rp, ['show', '--pretty=format:', '--patch', '--find-renames', sha, '--', rel]);
      return shape(r.out);
    }
    if (kind === '?') return wholeFile(ap, '+');
    let r = await run(rp, ['diff', '--find-renames', 'HEAD', '--', rel], { ok: true });
    if (r.code && /unknown revision|bad revision|ambiguous argument/.test(r.err)) {       // first commit not made yet
      r = await run(rp, ['diff', '--cached', '--', rel], { ok: true });
      if (!r.out.trim()) return wholeFile(ap, '+');
    } else if (r.code) throw new Problem(r.err.trim().split('\n').pop() || 'Git could not compare that file.');
    return shape(r.out);
  }
  function shape(out) {
    if (/^Binary files .* differ$/m.test(out) && !/^@@/m.test(out)) return { text: '', note: 'Binary file. Not shown.' };
    const at = out.search(/^@@/m);
    if (at < 0) return { text: '', note: out.trim() ? 'No text changes (mode or rename only).' : 'No changes.' };
    return clip(out.slice(at).replace(/\r/g, ''));
  }

  // ---------- history ----------
  async function log({ repo }) {
    const rp = repoPath(repo);
    const r = await run(rp, ['log', '-n', '150', '--date=iso-strict', '--pretty=format:%H%x1f%h%x1f%an%x1f%ad%x1f%s%x1e'], { ok: true });
    if (r.code) return { commits: [] };                                 // no commits yet
    const local = new Set();
    const u = await run(rp, ['rev-list', '-n', '500', '@{u}..HEAD'], { ok: true });
    if (!u.code) for (const l of u.out.split('\n')) if (l) local.add(l);
    const noUp = !!u.code;
    return { commits: r.out.split('\x1e').map(x => x.replace(/^\n/, '')).filter(Boolean).map(x => {
      const [sha, short, author, date, subject] = x.split('\x1f');
      return { sha, short, author, date, subject, local: noUp ? false : local.has(sha) };
    }) };
  }
  async function commitFiles({ repo, sha }) {
    const rp = repoPath(repo);
    if (!goodSha(sha)) throw new Problem('Bad commit.');
    const r = await run(rp, ['show', '--name-status', '--find-renames', '-z', '--pretty=format:%an%x1f%ae%x1f%ad%x1f%B%x1e', '--date=iso-strict', sha]);
    const cut = r.out.indexOf('\x1e');
    const [author, email, date, body] = r.out.slice(0, cut).split('\x1f');
    const parts = r.out.slice(cut + 1).replace(/^\n/, '').split('\0').filter(x => x !== '');
    const files = [];
    for (let i = 0; i < parts.length; i++) {
      const s = parts[i].trim();
      if (/^[RC]\d*$/.test(s)) { files.push({ kind: 'R', orig: parts[i + 1], path: parts[i + 2] }); i += 2; }
      else if (/^[AMDTU]$/.test(s)) { files.push({ kind: s === 'T' ? 'M' : s, path: parts[i + 1] }); i += 1; }
    }
    return { author, email, date, body: (body || '').trim(), files };
  }

  // ---------- commit: exactly the ticked files, like GitHub Desktop ----------
  async function commit({ repo, files, summary, description }) {
    const rp = repoPath(repo);
    summary = String(summary || '').trim();
    if (!summary) throw new Problem('Type a summary first.');
    if (!Array.isArray(files) || !files.length) throw new Problem('Tick at least one file.');
    const rels = [];
    for (const f of files) rels.push(path.relative(rp, filePath(rp, f)).split(path.sep).join('/'));
    const born = !(await run(rp, ['rev-parse', '--verify', '-q', 'HEAD'], { ok: true })).code;
    if (born) await run(rp, ['reset', '-q'], { write: true });           // clear the staging area; working files are untouched
    else await run(rp, ['rm', '-r', '-q', '--cached', '--ignore-unmatch', '.'], { write: true, ok: true });
    await run(rp, ['add', '-A', '--pathspec-from-file=-', '--pathspec-file-nul'], { write: true, input: rels.join('\0') + '\0' });
    const args = ['commit', '-q', '-m', summary];
    const desc = String(description || '').trim();
    if (desc) args.push('-m', desc);
    await run(rp, args, { write: true, timeout: 60000 });
    const sha = (await run(rp, ['rev-parse', '--short', 'HEAD'])).out.trim();
    return { sha };
  }

  // ---------- branches ----------
  async function branches({ repo }) {
    const rp = repoPath(repo);
    const r = await run(rp, ['branch', '--sort=-committerdate', '--format=%(refname:short)%1f%(HEAD)%1f%(upstream:short)']);
    return { branches: r.out.split('\n').filter(Boolean).map(l => { const [name, head, up] = l.split('\x1f'); return { name, current: head === '*', upstream: up || null }; })
      .filter(b => !b.name.startsWith('(')) };
  }
  async function branchName(rp, name) {
    name = String(name || '').trim().replace(/\s+/g, '-');
    if (!name || name.startsWith('-')) throw new Problem('Type a branch name.');
    const r = await run(rp, ['check-ref-format', '--branch', name], { ok: true });
    if (r.code) throw new Problem('That is not a valid branch name.');
    return name;
  }
  async function checkout({ repo, name }) {
    const rp = repoPath(repo); const n = await branchName(rp, name);
    await run(rp, ['checkout', '-q', n, '--'], { write: true, timeout: 60000 });
    return { branch: n };
  }
  async function branchNew({ repo, name }) {
    const rp = repoPath(repo); const n = await branchName(rp, name);
    await run(rp, ['checkout', '-q', '-b', n], { write: true });
    return { branch: n };
  }

  // ---------- fetch, pull, push ----------
  async function sync({ repo, op }) {
    const rp = repoPath(repo);
    const net = { write: true, timeout: 180000 };
    // Git Credential Manager ships with Git for Windows and with GitHub Desktop's git. It opens its own sign in window when needed.
    const cred = process.platform === 'win32' ? ['-c', 'credential.helper=manager'] : [];
    if (op === 'fetch') { await run(rp, [...cred, 'fetch', '--prune', '--quiet'], net); return { did: 'Fetched.' }; }
    if (op === 'pull') {
      try { await run(rp, [...cred, 'pull', '--ff-only', '--quiet'], net); }
      catch (e) {
        if (/not possible to fast-forward|diverg|Need to specify how to reconcile/i.test(e.message)) throw new Problem('Your branch and the one on GitHub have both changed. Loom only does simple pulls. Merge this one in GitHub Desktop.');
        throw e;
      }
      return { did: 'Pulled.' };
    }
    if (op === 'push') {
      const st = parseStatus((await run(rp, ['status', '--porcelain=v2', '--branch', '-z', '--untracked-files=no'])).out);
      if (st.detached || !st.branch) throw new Problem('Not on a branch, so there is nothing to push.');
      if (st.upstream) await run(rp, [...cred, 'push', '--quiet'], net);
      else await run(rp, [...cred, 'push', '--quiet', '-u', 'origin', st.branch], net);
      return { did: st.upstream ? 'Pushed.' : 'Published ' + st.branch + '.' };
    }
    throw new Problem('Unknown action.');
  }

  // Put one file back to how it was in the last commit. The current copy is not destroyed:
  // the caller moves it to the app trash first (see main.js), so it can be dragged back.
  async function restore({ repo, file, kind }) {
    const rp = repoPath(repo); const ap = filePath(rp, file);
    const rel = path.relative(rp, ap).split(path.sep).join('/');
    if (kind === '?') return { ok: true };                               // untracked: moving it to the trash was the whole job
    if (kind === 'A') { await run(rp, ['rm', '-q', '--cached', '--ignore-unmatch', '--', rel], { write: true }); return { ok: true }; }
    if (kind !== 'M' && kind !== 'D') throw new Problem('Loom can only discard edited, deleted and new files. Do this one in GitHub Desktop.');
    await run(rp, ['checkout', '-q', 'HEAD', '--', rel], { write: true });
    return { ok: true };
  }

  return { repos, status, diff, log, commitFiles, commit, branches, checkout, branchNew, sync, restore, filePath, repoPath,
    found: () => ({ git: git() }) };
}

module.exports = { create, findGit, scrub };
