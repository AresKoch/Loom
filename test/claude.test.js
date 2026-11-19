const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { launch, cmdQuote } = require('../claude');

const NOTE = 'You are running inside Loom. Keep "this" & that < short > 100% of the time.';

test('claude.exe is started directly with its arguments untouched', () => {
  const how = launch('C:\\Users\\me\\.local\\bin\\claude.exe', ['-p', '--append-system-prompt', NOTE]);
  assert.strictEqual(how.file, 'C:\\Users\\me\\.local\\bin\\claude.exe');
  assert.deepStrictEqual(how.args, ['-p', '--append-system-prompt', NOTE]);
  assert.ok(!how.options.shell);
});

test('an npm claude.cmd is resolved to node plus its script, so no shell splits the arguments (audit issue 1)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-npm-'));
  const script = path.join(dir, 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js');
  fs.mkdirSync(path.dirname(script), { recursive: true }); fs.writeFileSync(script, '');
  fs.writeFileSync(path.join(dir, 'node.exe'), '');
  const cmd = path.join(dir, 'claude.cmd');
  fs.writeFileSync(cmd, '@ECHO off\r\n"%dp0%\\node.exe"  "%dp0%\\node_modules\\@anthropic-ai\\claude-code\\cli.js" %*\r\n');
  const how = launch(cmd, ['--append-system-prompt', NOTE]);
  assert.strictEqual(how.file, path.join(dir, 'node.exe'));
  assert.strictEqual(path.normalize(how.args[0].replace(/\\/g, path.sep)), script);
  assert.strictEqual(how.args[2], NOTE);                 // one argument, spaces and all
  assert.ok(!how.options.shell);
});

test('when the script cannot be found, every argument is quoted for cmd.exe', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-npm-'));
  const cmd = path.join(dir, 'claude.cmd'); fs.writeFileSync(cmd, '@echo off\r\n');
  const how = launch(cmd, ['-p', NOTE]);
  assert.match(how.file, /cmd(\.exe)?$/i);
  assert.deepStrictEqual(how.args.slice(0, 3), ['/d', '/s', '/c']);
  assert.strictEqual(how.options.windowsVerbatimArguments, true);
  assert.ok(!how.options.shell);
  const q = cmdQuote(NOTE);
  assert.ok(q.startsWith('^^^"') && q.endsWith('^^^"'));  // quoted, and the quotes themselves escaped for both passes
  assert.ok(!/(^|[^^]) /.test(q));                        // no bare space left for cmd.exe to split on
  assert.ok(q.includes('^^^&') && q.includes('^^^<') && q.includes('^^^%'));
});
