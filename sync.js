// Loom sync: a written handoff between this PC and the phone.
//
// It does not copy your projects anywhere. Each sync writes down what happened since the last
// one (Loom chats, files that changed, commits, the board) plus a map of what exists in each
// project and a copy of its small text documents, has Claude turn that into a short handoff,
// and pushes it to one small private GitHub repository. Claude on the phone opens that
// repository, reads LATEST.md and can talk about any of it. Anything the phone session wrote
// back is pulled in first, so it works in both directions.
//
// The sync repository lives in ROOT\.folder-map\sync, out of sight of the browser and search.
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { execFile, spawn } = require('child_process');
const { HEAVY_DIRS } = require('./skip');
const { findGit, scrub } = require('./git');
const claudeLib = require('./claude');

const STORE = '.folder-map', TRASH = '.folder-map-trash';
const DOC_MAX = 150 * 1024;          // biggest text document copied per file
const RAW_MAX = 140 * 1024;          // most raw notes handed to Claude
const TEXT_EXT = new Set(['md', 'txt']);

const GUIDE = `# Loom sync

This repository is a written handoff between Ares's laptop (the Loom app) and Claude on his phone.
It holds notes about his projects, not the projects themselves. The real files stay on the laptop.

## What is here

- \`LATEST.md\`  where everything stands right now. Read this first.
- \`log/\`  one dated file per sync. \`-laptop\` files come from Loom, \`-phone\` files from phone sessions.
  \`.raw.md\` files are the unedited facts Loom gathered (chat excerpts, changed files, commits).
- \`projects/<name>/STATUS.md\`  a running page per project.
- \`projects/<name>/TREE.md\`  what folders and files exist in that project on the laptop, with sizes.
- \`projects/<name>/files/\`  copies of that project's small text documents (CLAUDE.md, README, scope, decisions).
- \`state.json\`  bookkeeping for Loom. Leave it alone.

## When Ares says "catch up"

Read \`LATEST.md\`, then the STATUS.md of whichever project he wants to talk about. Use TREE.md to
know what files exist. You cannot open the files listed there; they are on his laptop. Say so
plainly if he asks for something only the laptop has, and note it for the next laptop session.

## Before a session ends, or when he says "sync" or "log that"

1. Write \`log/YYYY-MM-DD-HHMM-phone.md\` with: what was discussed, what was decided, open
   questions, and what to do next on the laptop. Keep it short and factual. Only record what was
   actually said.
2. Add or update a "From the phone" section at the top of \`LATEST.md\` pointing at that file.
3. Commit and push. Push to \`main\` if you can. If you can only push a branch, that is fine:
   Loom merges branches in the next time Sync is pressed on the laptop.

Do not edit anything under \`projects/*/files/\` or any \`TREE.md\`; Loom rewrites those on every sync.
`;

function create({ root, Problem }) {
  let step = '';
  let running = false;
  const dir = () => path.join(root(), STORE, 'sync');
  const pcName = () => (process.env.COMPUTERNAME || require('os').hostname() || 'laptop').replace(/[^\w.-]/g, '').slice(0, 30) || 'laptop';
  const exists = async p => { try { await fsp.access(p); return true; } catch (e) { return false; } };
  const readJson = async (p, d) => { try { return JSON.parse(await fsp.readFile(p, 'utf8')); } catch (e) { return d; } };

  function git(cwd, args, opts) {
    opts = opts || {};
    return new Promise((resolve, reject) => {
      const exe = findGit();
      if (!exe) return reject(new Problem('Git was not found on this PC. Install Git for Windows or GitHub Desktop.'));
      const cred = opts.net && process.platform === 'win32' ? ['-c', 'credential.helper=manager'] : [];
      execFile(exe, ['-c', 'core.quotepath=false', ...cred, ...args],
        { cwd, windowsHide: true, maxBuffer: 32 * 1024 * 1024, timeout: opts.net ? 180000 : 30000, encoding: 'utf8',
          env: { ...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C', LANG: 'C' } },
        (err, out, errOut) => {
          if (err && !opts.ok) return reject(new Problem(scrub((errOut || '').trim() || err.message).split('\n').filter(Boolean).slice(-4).join('\n')));
          resolve({ out: out || '', code: err ? 1 : 0 });
        });
    });
  }

  const goodUrl = u => /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+?(\.git)?\/?$/.test(u) || (!!process.env.LOOM_SYNC_TEST && u.length > 0);

  async function status() {
    if (!root()) return { set: false };
    const d = dir();
    if (!(await exists(path.join(d, '.git')))) return { set: false };
    const url = scrub((await git(d, ['remote', 'get-url', 'origin'], { ok: true })).out.trim());
    const st = await readJson(path.join(d, 'state.json'), {});
    return { set: true, url, last: st.last || null, running, step };
  }

  // Connect this root folder to the sync repository. Clones it into ROOT\.folder-map\sync.
  async function setup({ url }) {
    if (!root()) throw new Problem('Choose a root folder first.');
    url = String(url || '').trim();
    if (!goodUrl(url)) throw new Problem('That does not look like a GitHub repository address. It should look like https://github.com/yourname/loom-sync');
    const d = dir();
    if (await exists(path.join(d, '.git'))) throw new Problem('Sync is already connected for this root folder.');
    await fsp.mkdir(path.dirname(d), { recursive: true });
    if (await exists(d)) { if ((await fsp.readdir(d)).length) throw new Problem('The sync folder already has files in it: ' + d); await fsp.rmdir(d); }
    try { await git(path.dirname(d), ['clone', '--quiet', url, 'sync'], { net: true }); }
    catch (e) { throw new Problem('Could not reach that repository. Check that it exists and that you are signed in to GitHub on this PC.\n' + e.message); }
    // An empty repository has no branch yet: make sure the first commit lands on main.
    if ((await git(d, ['rev-parse', '--verify', '-q', 'HEAD'], { ok: true })).code) await git(d, ['symbolic-ref', 'HEAD', 'refs/heads/main'], { ok: true });
    if (!(await git(d, ['config', 'user.email'], { ok: true })).out.trim()) {
      const u = (process.env.USERNAME || process.env.USER || 'loom').replace(/[^\w.-]/g, '') || 'loom';
      await git(d, ['config', 'user.name', u]); await git(d, ['config', 'user.email', u + '@users.noreply.github.com']);
    }
    return { ok: true, url: scrub(url) };
  }

  // ---------- gathering the facts (no AI in this part) ----------
  const stamp = d => { const z = n => String(n).padStart(2, '0'); return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())}-${z(d.getHours())}${z(d.getMinutes())}`; };
  const kb = n => (n < 1024 ? n + ' B' : n < 1048576 ? Math.round(n / 1024) + ' KB' : n < 1073741824 ? (n / 1048576).toFixed(1) + ' MB' : (n / 1073741824).toFixed(2) + ' GB');
  const hidden = n => n === STORE || n === TRASH || n === '.git';
  const safeName = n => n.replace(/[<>:"|?*\\/]/g, '_').slice(0, 80);

  async function projects() {
    let ents = [];
    try { ents = await fsp.readdir(root(), { withFileTypes: true }); } catch (e) { /* none */ }
    return ents.filter(e => e.isDirectory() && !hidden(e.name) && !HEAVY_DIRS.has(e.name) && !e.name.startsWith('.') && !e.name.startsWith('$')).map(e => e.name)
      .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
  }

  // What exists in one project: folders and files three levels deep, with sizes.
  async function tree(top) {
    const lines = []; let total = 0, count = 0;
    const walk = async (d, depth, indent) => {
      let ents;
      try { ents = await fsp.readdir(d, { withFileTypes: true }); } catch (e) { return; }
      ents = ents.filter(e => !hidden(e.name) && !e.isSymbolicLink()).sort((a, b) => (b.isDirectory() - a.isDirectory()) || a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
      let shown = 0;
      for (const e of ents) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) {
          if (HEAVY_DIRS.has(e.name)) { if (lines.length < 600) lines.push(`${indent}- ${e.name}/  (not listed)`); continue; }
          if (lines.length < 600) lines.push(`${indent}- ${e.name}/`);
          if (depth < 3) await walk(p, depth + 1, indent + '  '); else { const s = await sizeOf(p); total += s.bytes; count += s.files; if (lines.length < 600) lines[lines.length - 1] += `  (${s.files} files, ${kb(s.bytes)})`; }
        } else {
          let sz = 0; try { sz = (await fsp.stat(p)).size; } catch (er) { /* gone */ }
          total += sz; count++;
          if (shown++ < 40 && lines.length < 600) lines.push(`${indent}- ${e.name}  (${kb(sz)})`);
        }
      }
      const files = ents.filter(e => !e.isDirectory()).length;
      if (files > 40 && lines.length < 600) lines.push(`${indent}- ... and ${files - 40} more files here`);
    };
    const budget = { n: 0 };
    async function sizeOf(p) {
      const r = { bytes: 0, files: 0 };
      const w = async q => {
        if (budget.n++ > 60000) return;
        let ents; try { ents = await fsp.readdir(q, { withFileTypes: true }); } catch (e) { return; }
        for (const e of ents) {
          if (e.isSymbolicLink() || hidden(e.name)) continue;
          const x = path.join(q, e.name);
          if (e.isDirectory()) { if (!HEAVY_DIRS.has(e.name)) await w(x); } else { try { r.bytes += (await fsp.stat(x)).size; r.files++; } catch (er) { /* gone */ } }
        }
      };
      await w(p); return r;
    }
    await walk(top, 1, '');
    return { text: lines.join('\n') || '(empty)', total, count, cut: lines.length >= 600 };
  }

  // The small text documents worth reading on the phone: CLAUDE.md, README, and docs\*.md.
  async function docs(top) {
    const out = [];
    const take = async (abs, rel) => {
      try { const st = await fsp.lstat(abs); if (st.isFile() && st.size <= DOC_MAX && out.length < 14) out.push({ rel, text: await fsp.readFile(abs, 'utf8') }); } catch (e) { /* not there */ }
    };
    for (const n of ['CLAUDE.md', 'README.md', 'NOTES.md', 'TODO.md']) await take(path.join(top, n), n);
    for (const sub of ['docs', 'inbox']) {
      let ents = []; try { ents = await fsp.readdir(path.join(top, sub), { withFileTypes: true }); } catch (e) { /* none */ }
      for (const e of ents) if (e.isFile() && TEXT_EXT.has(e.name.split('.').pop().toLowerCase())) await take(path.join(top, sub, e.name), sub + '/' + e.name);
    }
    return out;
  }

  async function changedFiles(since) {
    const hits = []; let seen = 0;
    const walk = async (d, depth) => {
      if (depth > 9 || seen > 80000) return;
      let ents; try { ents = await fsp.readdir(d, { withFileTypes: true }); } catch (e) { return; }
      for (const e of ents) {
        if (e.isSymbolicLink() || hidden(e.name)) continue;
        const p = path.join(d, e.name);
        if (e.isDirectory()) { if (!HEAVY_DIRS.has(e.name)) await walk(p, depth + 1); continue; }
        seen++;
        try { const st = await fsp.stat(p); if (st.mtimeMs > since) hits.push({ rel: path.relative(root(), p).split(path.sep).join('/'), size: st.size, at: st.mtimeMs }); } catch (er) { /* gone */ }
      }
    };
    await walk(root(), 0);
    hits.sort((a, b) => b.at - a.at);
    return hits;
  }

  async function repoFacts(since) {
    const found = [];
    const walk = async (d, depth) => {
      if (found.length >= 60) return;
      let ents; try { ents = await fsp.readdir(d, { withFileTypes: true }); } catch (e) { return; }
      if (ents.some(e => e.name === '.git')) { found.push(d); return; }
      if (depth >= 4) return;
      for (const e of ents) if (e.isDirectory() && !HEAVY_DIRS.has(e.name) && !e.name.startsWith('.')) await walk(path.join(d, e.name), depth + 1);
    };
    await walk(root(), 0);
    const out = [];
    for (const rp of found) {
      const rel = path.relative(root(), rp).split(path.sep).join('/');
      const branch = (await git(rp, ['rev-parse', '--abbrev-ref', 'HEAD'], { ok: true })).out.trim();
      const log = (await git(rp, ['log', '--since=' + new Date(since).toISOString(), '--max-count=25', '--pretty=%h %s (%cr)'], { ok: true })).out.trim();
      const loose = (await git(rp, ['status', '--porcelain'], { ok: true })).out.split('\n').filter(Boolean).length;
      if (log || loose) out.push({ rel, branch, log, loose });
    }
    return out;
  }

  async function chatFacts(state) {
    const cd = path.join(root(), STORE, 'chats');
    let names = []; try { names = (await fsp.readdir(cd)).filter(n => n.endsWith('.json')); } catch (e) { /* none */ }
    const out = [], counts = {};
    for (const n of names) {
      const id = n.slice(0, -5), c = await readJson(path.join(cd, n), null);
      if (!c || !Array.isArray(c.msgs)) continue;
      counts[id] = c.msgs.length;
      const from = (state.chats || {})[id] || 0;
      if (c.msgs.length <= from) continue;
      const lines = [];
      for (const m of c.msgs.slice(from)) {
        if (m.role === 'user') lines.push('Ares: ' + String(m.text || ''));
        else if (m.role === 'ai' && Array.isArray(m.parts)) {
          const tools = m.parts.filter(p => p.k === 'tool' && p.write).map(p => p.line);
          const t = m.parts.filter(p => p.k === 'text').map(p => p.text).join('\n').trim();
          if (tools.length) lines.push('(Claude ' + tools.join(', ') + ')');
          if (t) lines.push('Claude: ' + t);
        }
      }
      if (lines.length) out.push({ title: c.title || 'Chat', at: c.at || 0, text: lines.join('\n\n').slice(-9000) });
    }
    out.sort((a, b) => b.at - a.at);
    return { chats: out.slice(0, 14), counts };
  }

  async function boardFacts() {
    const b = await readJson(path.join(root(), STORE, 'board.json'), { notes: [] });
    return (b.notes || []).map(n => (n.parts || []).map(p => (p.p != null ? '/' + p.p : p.t || '')).join('').trim()).filter(Boolean);
  }

  // ---------- Claude writes the handoff ----------
  function askClaude(cwd, prompt) {
    return new Promise(resolve => {
      const exe = claudeLib.findClaude();
      if (!exe) return resolve({ ok: false, why: 'Claude Code is not installed on this PC.' });
      const how = claudeLib.launch(exe, ['-p', ...claudeLib.MODES.edit, '--output-format', 'text']);
      const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
      let child, done = false, err = '';
      const finish = r => { if (done) return; done = true; clearTimeout(timer); resolve(r); };
      try { child = spawn(how.file, how.args, { cwd, windowsHide: true, env, stdio: ['pipe', 'ignore', 'pipe'], ...how.options }); }
      catch (e) { return resolve({ ok: false, why: e.message }); }
      const timer = setTimeout(() => {
        try { if (process.platform === 'win32') execFile('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true }, () => {}); else child.kill(); } catch (e) { /* gone */ }
        finish({ ok: false, why: 'Claude took longer than five minutes.' });
      }, 5 * 60 * 1000);
      child.stderr.setEncoding('utf8'); child.stderr.on('data', d => { err = (err + d).slice(-600); });
      child.on('error', e => finish({ ok: false, why: e.message }));
      child.on('close', code => finish(code ? { ok: false, why: err.trim().split('\n').pop() || 'Claude exited with code ' + code } : { ok: true }));
      child.stdin.on('error', () => {});
      child.stdin.end(prompt);
    });
  }

  // ---------- one sync ----------
  async function run() {
    if (running) throw new Problem('A sync is already running.');
    if (!root()) throw new Problem('Choose a root folder first.');
    const d = dir();
    if (!(await exists(path.join(d, '.git')))) throw new Problem('Sync is not connected yet.');
    running = true;
    try {
      const notes = [];
      // 1. Bring in whatever the phone wrote.
      step = 'Getting what your phone wrote';
      const before = new Set(await fsp.readdir(path.join(d, 'log')).catch(() => []));
      await git(d, ['fetch', '--prune', '--quiet', 'origin'], { net: true });
      const born = !(await git(d, ['rev-parse', '--verify', '-q', 'HEAD'], { ok: true })).code;
      const remoteMain = !(await git(d, ['rev-parse', '--verify', '-q', 'origin/main'], { ok: true })).code;
      if (remoteMain && !born) await git(d, ['checkout', '-q', '-B', 'main', 'origin/main']);
      else if (remoteMain) {
        const m = await git(d, ['merge', '--no-edit', '-q', 'origin/main'], { ok: true });
        if (m.code) { await git(d, ['merge', '--abort'], { ok: true }); notes.push('Could not merge the copy on GitHub cleanly. Your laptop notes were kept; check the repository on GitHub.'); }
      }
      if (remoteMain || born) {
        const branches = (await git(d, ['branch', '-r', '--no-merged', 'HEAD', '--format=%(refname:short)'], { ok: true })).out.split('\n').map(s => s.trim()).filter(b => b && b !== 'origin/main' && !b.endsWith('/HEAD'));
        for (const b of branches.slice(0, 12)) {
          const m = await git(d, ['merge', '--no-edit', '-q', b], { ok: true });
          if (m.code) { await git(d, ['merge', '--abort'], { ok: true }); notes.push('A phone session left notes on ' + b.replace(/^origin\//, '') + ' that could not be merged automatically.'); }
        }
      }
      const fromPhone = (await fsp.readdir(path.join(d, 'log')).catch(() => [])).filter(n => !before.has(n) && /phone/i.test(n) && !n.endsWith('.raw.md'));

      // 2. Gather the facts.
      const state = await readJson(path.join(d, 'state.json'), {});
      const now = new Date(), since = state.last ? Date.parse(state.last) : now.getTime() - 7 * 24 * 3600 * 1000;
      step = 'Reading your chats and the board';
      const { chats, counts } = await chatFacts(state);
      const board = await boardFacts();
      step = 'Looking at what changed';
      const changed = await changedFiles(since);
      const repos = await repoFacts(since);
      step = 'Mapping your projects';
      const names = await projects();
      await fsp.rm(path.join(d, 'projects', '_root'), { recursive: true, force: true });
      const sizes = [];
      for (const name of names) {
        const top = path.join(root(), name), pd = path.join(d, 'projects', safeName(name));
        const t = await tree(top);
        sizes.push({ name, total: t.total, count: t.count });
        await fsp.rm(path.join(pd, 'files'), { recursive: true, force: true });
        await fsp.mkdir(path.join(pd, 'files'), { recursive: true });
        await fsp.writeFile(path.join(pd, 'TREE.md'), `# ${name}: what is on the laptop\n\n${t.count.toLocaleString()} files, ${kb(t.total)}. Listed three folders deep${t.cut ? ', cut short because it is long' : ''}. These files are on the laptop only.\n\n${t.text}\n`);
        for (const doc of await docs(top)) { const fp = path.join(pd, 'files', ...doc.rel.split('/')); await fsp.mkdir(path.dirname(fp), { recursive: true }); await fsp.writeFile(fp, doc.text); }
        if (!(await exists(path.join(pd, 'STATUS.md')))) await fsp.writeFile(path.join(pd, 'STATUS.md'), `# ${name}\n\nNo status written yet.\n`);
      }
      const rootDocs = await docs(root());
      for (const doc of rootDocs.filter(x => !x.rel.includes('/'))) { const fp = path.join(d, 'projects', '_root', 'files', doc.rel); await fsp.mkdir(path.dirname(fp), { recursive: true }); await fsp.writeFile(fp, doc.text); }

      // 3. The raw notes: everything above as plain text. Kept in the log, and the fallback if Claude is not available.
      const st = stamp(now), touched = new Set();
      for (const f of changed) touched.add(f.rel.split('/')[0]);
      for (const r of repos) touched.add(r.rel.split('/')[0]);
      let raw = `# Raw notes from ${pcName()}, ${now.toLocaleString()}\n\nCovers ${state.last ? 'everything since the last sync on ' + new Date(since).toLocaleString() : 'the last seven days (first sync)'}. Root folder: ${path.basename(root())}.\n`;
      raw += `\n## Projects\n\n` + sizes.map(s => `- ${s.name}: ${s.count.toLocaleString()} files, ${kb(s.total)}${touched.has(s.name) ? '  (changed since last sync)' : ''}`).join('\n') + '\n';
      raw += `\n## Sticky notes on the board\n\n` + (board.length ? board.map(b => '- ' + b.replace(/\n+/g, ' / ')).join('\n') : '(none)') + '\n';
      raw += `\n## Git\n\n` + (repos.length ? repos.map(r => `### ${r.rel} (branch ${r.branch})\n${r.log || '(no new commits)'}\n${r.loose ? r.loose + ' file(s) changed but not committed.' : 'Nothing uncommitted.'}`).join('\n\n') : '(no new commits and nothing uncommitted)') + '\n';
      raw += `\n## Files changed (${changed.length})\n\n` + (changed.length ? changed.slice(0, 250).map(f => `- ${f.rel}  (${kb(f.size)}, ${new Date(f.at).toLocaleString()})`).join('\n') + (changed.length > 250 ? `\n- ... and ${changed.length - 250} more` : '') : '(none)') + '\n';
      raw += `\n## Loom chats since last sync (${chats.length})\n`;
      for (const c of chats) { if (raw.length > RAW_MAX) { raw += '\n(more chats left out to keep this short)\n'; break; } raw += `\n### ${c.title}\n\n${c.text}\n`; }
      await fsp.mkdir(path.join(d, 'log'), { recursive: true });
      const rawName = `log/${st}-laptop.raw.md`, logName = `log/${st}-laptop.md`;
      await fsp.writeFile(path.join(d, rawName), raw.slice(0, RAW_MAX + 4000));
      await fsp.writeFile(path.join(d, 'CLAUDE.md'), GUIDE);
      await fsp.writeFile(path.join(d, 'README.md'), '# loom-sync\n\nHandoff notes between Loom on the laptop and Claude on the phone. See CLAUDE.md for how it is laid out.\n');

      // 4. Claude turns the raw notes into the handoff.
      step = 'Claude is writing the handoff';
      const latest = path.join(d, 'LATEST.md');
      const wasLatest = await fsp.readFile(latest, 'utf8').catch(() => '');
      const prompt = `You are writing a handoff inside the loom-sync repository (see CLAUDE.md for the layout).\n` +
        `Loom has just gathered raw facts in ${rawName}. Read that file.` + (fromPhone.length ? ` Also read these notes that came in from phone sessions: ${fromPhone.map(n => 'log/' + n).join(', ')}.` : '') + `\n\n` +
        `Then do exactly this:\n` +
        `1. Write ${logName}: a short, factual handoff of this period. Sections: What got done, Decisions, Half-finished, Next steps, Open questions. Group by project. Only state what the raw notes support; where they do not say, write "not recorded".\n` +
        `2. Rewrite LATEST.md so it describes where everything stands now: one short section per project that has any activity or status, most recently active first, then a line listing the quiet projects. Start with the date and "Last synced from ${pcName()}". Keep anything still true from the old LATEST.md.` + (fromPhone.length ? ' Fold in what the phone notes say and remove the "From the phone" pointer once it is folded in.' : '') + `\n` +
        `3. For each project that changed (${[...touched].filter(n => names.includes(n)).join(', ') || 'none'}), update projects/<name>/STATUS.md with its current state and next steps.\n` +
        `Do not edit TREE.md files, anything under projects/*/files/, the raw file, CLAUDE.md or state.json. Do not run commands. Plain markdown, no preamble.`;
      const wrote = await askClaude(d, prompt);
      const nowLatest = await fsp.readFile(latest, 'utf8').catch(() => '');
      const claudeWrote = wrote.ok && nowLatest.trim() && nowLatest !== wasLatest;
      if (!claudeWrote) {
        notes.push('Claude did not write the summary this time' + (wrote.why ? ' (' + wrote.why + ')' : '') + ', so the handoff is the raw notes.');
        await fsp.writeFile(latest, `# Where things stand\n\nLast synced from ${pcName()}, ${now.toLocaleString()}. Claude did not summarise this sync, so these are the raw notes Loom gathered.\n\n` + raw.replace(/^# .*\n/, ''));
        if (!(await exists(path.join(d, logName)))) await fsp.writeFile(path.join(d, logName), `# ${st} from ${pcName()}\n\nNo summary was written. See ${rawName}.\n`);
      }

      // 5. Save and push.
      step = 'Sending it to GitHub';
      await fsp.writeFile(path.join(d, 'state.json'), JSON.stringify({ last: now.toISOString(), by: pcName(), chats: counts }, null, 1));
      await git(d, ['add', '-A']);
      const dirty = (await git(d, ['status', '--porcelain'])).out.trim();
      if (dirty) await git(d, ['commit', '-q', '-m', `Sync from ${pcName()}, ${now.toLocaleString()}`]);
      await git(d, ['branch', '-M', 'main'], { ok: true });
      try { await git(d, ['push', '--quiet', '-u', 'origin', 'main'], { net: true }); }
      catch (e) { throw new Problem('The handoff was written but could not be sent to GitHub. Check that you are signed in to GitHub on this PC, then press Sync again.\n' + e.message); }
      const url = scrub((await git(d, ['remote', 'get-url', 'origin'], { ok: true })).out.trim()).replace(/\.git$/, '');
      return { ok: true, claudeWrote, fromPhone, changed: changed.length, chats: chats.length, repos: repos.length, projects: names.length, notes, url, latest };
    } finally { running = false; step = ''; }
  }

  return { status, setup, run, dir, progress: () => ({ running, step }) };
}

module.exports = { create };
