#!/usr/bin/env node
// Send keys and chat commands to Minecraft Education on Windows without taking the foreground.
//
// Why it exists: BlockHand's collaboration order is "background > foreground > the player".
// Game commands go through the MCP bridge, but the chat bar and the menus need keystrokes
// (typing /connect, a chat-bar /reload all, leaving and re-entering a world). On macOS the
// Claude desktop app can send those in the background (app_batch with target "focused");
// on Windows this helper does it with Win32 PostMessage, which never changes focus.
//
// It sends keyboard input only. Mouse buttons posted this way did not mine blocks in the
// tested setup, so mining or attacking still needs another approach.
//
// Run chat commands from PowerShell or cmd. Git Bash rewrites an argument that starts with "/"
// into a file path ("/reload all" arrives as "C:/Program Files/Git/reload all"); this helper
// refuses such arguments.
//
// The result says what was queued, not what the game did: confirm on screen or through MCP.

import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PS1 = join(HERE, 'game-keys.ps1');

const KEY_NAMES = new Set(['escape', 'return', 'enter', 'tab', 'shift', 'left', 'up', 'right', 'down', 't']);
const MODIFIERS = new Set(['shift']);
const MAX_TEXT = 256;
/** Keys per call. With the per-key pacing this keeps a call well inside its time limits. */
const MAX_KEYS = 24;
/** Safety net only: the PowerShell side stops itself between whole keys after 12 seconds. */
const TIMEOUT_MS = 20_000;

const HELP = `blockhand-keys: send keys to Minecraft Education on Windows without taking the foreground.

  --probe              find the game window and report it; sends nothing
  --open-chat          press T to open the chat bar. Take a screenshot to confirm it opened.
  --send <text>        type into the chat bar that is already open, then press Enter
  --chat <text>        --open-chat and --send in one call. Only when the game is in a world
                       with no screen or menu open; otherwise the text lands as hotkeys.
  --keys <k,k,...>     up to ${MAX_KEYS} keys: escape return tab left up right down t, or shift+<key>
  --text <text>        type characters without pressing Enter
  --pid <n>            choose one game when several are running (see --probe)
  --help               this text

Text is 1-${MAX_TEXT} characters without control characters. Run chat commands from PowerShell
or cmd, not Git Bash. One call sends at a time (a second one gets ERROR=busy); between calls
another agent could still type, so only one agent should drive the game screen at a time.
Output lists what was queued, plus focus_unchanged=True when the foreground window stayed the
same. It does not prove the game acted: confirm on screen or through BlockHand.
`;

function usage(message) {
  if (message) process.stderr.write(`${message}\n\n`);
  process.stderr.write(HELP);
  process.exit(2);
}

// ---- parse and validate everything before any input is sent ---------------
const FLAGS_WITH_VALUE = new Set(['--keys', '--text', '--send', '--chat', '--pid']);
const FLAGS_BARE = new Set(['--probe', '--open-chat']);

const argv = process.argv.slice(2);
if (argv.includes('--help') || argv.includes('-h')) {
  process.stdout.write(HELP);
  process.exit(0);
}

const options = {};
for (let i = 0; i < argv.length; i++) {
  const flag = argv[i];
  if (FLAGS_BARE.has(flag)) {
    options[flag] = true;
  } else if (FLAGS_WITH_VALUE.has(flag)) {
    if (i + 1 >= argv.length) usage(`${flag} needs a value`);
    if (flag in options) usage(`${flag} given twice`);
    options[flag] = argv[++i];
  } else {
    usage(`unknown argument: ${flag}`);
  }
}

const actions = ['--probe', '--keys', '--text', '--open-chat', '--send', '--chat'].filter((f) => f in options);
if (actions.length === 0) usage('nothing to do');
if (options['--probe'] && actions.length > 1) usage('--probe cannot be combined with input');
if (options['--chat'] && (options['--open-chat'] || options['--send'])) usage('--chat already opens the chat bar and sends');

function checkText(flag) {
  const value = options[flag];
  if (value === undefined) return;
  if (value.length === 0 || value.length > MAX_TEXT) usage(`${flag} must be 1-${MAX_TEXT} characters`);
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(value)) usage(`${flag} must not contain control characters`);
  if (value.startsWith('C:/') || /^[A-Za-z]:[\\/]/.test(value)) {
    usage(`${flag} looks like a file path; if you meant a chat command, run this from PowerShell, not Git Bash`);
  }
}
['--text', '--send', '--chat'].forEach(checkText);

if (options['--keys'] !== undefined) {
  const keys = options['--keys'].split(',').map((k) => k.trim().toLowerCase()).filter(Boolean);
  if (keys.length === 0) usage('--keys is empty');
  if (keys.length > MAX_KEYS) usage(`--keys takes at most ${MAX_KEYS} keys per call`);
  for (const key of keys) {
    const parts = key.split('+');
    for (const part of parts) if (!KEY_NAMES.has(part)) usage(`unknown key: ${part}`);
    for (const mod of parts.slice(0, -1)) if (!MODIFIERS.has(mod)) usage(`only shift can be held: ${key}`);
  }
  options['--keys'] = keys.join(',');
}

if (options['--pid'] !== undefined && !/^\d{1,7}$/.test(options['--pid'])) usage('--pid must be a process id');

if (process.platform !== 'win32') {
  process.stderr.write(
    'This helper is for Windows. On macOS, use the Claude desktop app: app_batch with key/type actions '
    + 'and target: "focused" (the stand-alone app_key ignores target).\n',
  );
  process.exit(2);
}

// ---- send ------------------------------------------------------------------
// Only one sender at a time: two sessions typing at once would interleave characters, and one
// Enter could send the other's half-typed command. The PowerShell side holds a named mutex for
// the whole call; the system releases it if that process dies, so nothing can go stale.
const psArgs = [];
if (options['--probe']) psArgs.push('-Probe');
if (options['--keys']) psArgs.push('-Keys', options['--keys']);
if (options['--text']) psArgs.push('-Text', options['--text']);
if (options['--open-chat']) psArgs.push('-OpenChat');
if (options['--send']) psArgs.push('-Send', options['--send']);
if (options['--chat']) psArgs.push('-Chat', options['--chat']);
if (options['--pid']) psArgs.push('-TargetPid', options['--pid']);

const res = spawnSync(
  'powershell.exe',
  ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', PS1, ...psArgs],
  { encoding: 'utf8', timeout: TIMEOUT_MS, windowsHide: true },
);
process.stdout.write(res.stdout ?? '');
if (res.stderr) process.stderr.write(res.stderr);
if (res.error) {
  process.stdout.write(`ERROR=${res.error.code === 'ETIMEDOUT' ? 'timeout' : 'spawn_failed'}\n`);
  process.exit(1);
}
process.exit(typeof res.status === 'number' ? res.status : 1);
