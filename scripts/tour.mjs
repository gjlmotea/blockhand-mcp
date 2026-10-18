/**
 * 導覽拍攝器：照劇本把相機擺到每個機位、截圖，最後接成影片。
 *
 * 它走的是跟 run-tools.mjs 一樣的 MCP 工具面（不是後門），差別只在
 * 每擺完一個機位就 shell 出去 screencapture 寫一張圖。
 *
 * 用法：
 *   node scripts/tour.mjs --spec <tour.json> --out <目錄> [--dry] [--no-video]
 *
 * 前提（做不到就會拍到霧或拍到別的視窗）：
 *   1. 遊戲必須全螢幕。截的是整個螢幕，沒有裁切、沒有視窗邊框。
 *   2. 相機要用旁觀者模式，創造模式會往下掉。
 *   3. 遠處的新區塊要先掛刷新區域並等 45–60 秒，否則拍到的是霧。
 *   4. 時間與天氣要釘死，否則每張光線不一樣。
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { getDefaultEnvironment, StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const arg = (k, d) => { const i = process.argv.indexOf(k); return i < 0 ? d : process.argv[i + 1]; };
const has = k => process.argv.includes(k);
const specPath = arg('--spec');
const outDir = resolve(arg('--out', './tour-out'));
if (!specPath) { process.stderr.write('Usage: node scripts/tour.mjs --spec <tour.json> --out <dir>\n'); process.exit(2); }
const spec = JSON.parse(readFileSync(specPath, 'utf8'));
const shotsDir = join(outDir, 'shots');
mkdirSync(shotsDir, { recursive: true });

const sleep = ms => new Promise(r => setTimeout(r, ms));
const log = (...a) => process.stdout.write(a.join(' ') + '\n');

// ---- 相機路徑：關鍵影格之間做 Catmull-Rom 內插，端點各補一格當切線 ----
const cr = (p0, p1, p2, p3, t) => { const t2 = t * t, t3 = t2 * t;
  return 0.5 * ((2 * p1) + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (-p0 + 3 * p1 - 3 * p2 + p3) * t3); };
function interpolate(keys, frames) {
  const k = [keys[0], ...keys, keys[keys.length - 1]];           // 端點各複製一份
  const out = [];
  for (let f = 0; f < frames; f++) {
    const u = (f / Math.max(1, frames - 1)) * (keys.length - 1);
    const i = Math.min(keys.length - 2, Math.floor(u)), t = u - i;
    const pick = (arr, idx) => arr[idx];
    const at = n => k[i + n];
    const v = sel => cr(sel(at(0)), sel(at(1)), sel(at(2)), sel(at(3)), t);
    void pick;
    out.push({
      pos: [v(a => a.pos[0]), v(a => a.pos[1]), v(a => a.pos[2])].map(n => Math.round(n * 100) / 100),
      rot: [v(a => a.rot[0]), v(a => a.rot[1])].map(n => Math.round(n * 100) / 100),
    });
  }
  return out;
}

// ---- 把所有機位攤平成一條拍攝清單 ----
const plan = [];
for (const s of spec.shots ?? []) plan.push({ id: s.id, pos: s.pos, rot: s.rot, hold: s.holdMs ?? 900, kind: 'shot' });
for (const p of spec.paths ?? []) {
  const frames = interpolate(p.keys, p.frames ?? 60);
  frames.forEach((f, i) => plan.push({
    id: `${p.id}-${String(i).padStart(4, '0')}`, pos: f.pos, rot: f.rot,
    hold: p.holdMs ?? 180, kind: 'path', path: p.id, fps: p.fps ?? 24,
  }));
}
log(`Script: ${spec.shots?.length ?? 0} still shots + ${spec.paths?.length ?? 0} camera paths, ${plan.length} frames in total`);
if (has('--dry')) { writeFileSync(join(outDir, 'plan.json'), JSON.stringify(plan, null, 1)); log('--dry: wrote plan.json only; not connected'); process.exit(0); }

// ---- 連上遊戲 ----
const projectRoot = fileURLToPath(new URL('..', import.meta.url));
const transport = new StdioClientTransport({
  command: process.execPath, args: ['scripts/launch-mcp.mjs'], cwd: projectRoot, stderr: 'pipe',
  env: { ...getDefaultEnvironment(),
    MINECRAFT_EDU_WS_HOST: '127.0.0.1',
    MINECRAFT_EDU_WS_PORT: process.env.MINECRAFT_EDU_WS_PORT ?? '19131',
    MINECRAFT_EDU_WS_PORT_FALLBACK: process.env.MINECRAFT_EDU_WS_PORT_FALLBACK ?? '1' },
});
transport.stderr?.on('data', c => process.stderr.write(c));
const client = new Client({ name: 'blockhand-tour', version: '1.0.0' });
await client.connect(transport);
const call = (name, args = {}) => client.callTool({ name, arguments: args }, undefined, { timeout: 120_000 });
const cmd = async line => { const r = await call('mc_run_command', { command: line });
  const t = r?.content?.[0]?.text ?? ''; return t; };

const status = JSON.parse((await call('mc_status'))?.content?.[0]?.text ?? '{}');
if (!status.connected) {
  log(`The game is not connected yet. Type this in the chat: ${status.connectCommand ?? '/connect 127.0.0.1:19131'}`);
  await call('mc_await_connection', { timeoutSeconds: 180 });
}

// ---- 刷新區域 + 等載入（不等就拍到霧） ----
for (const t of spec.ticking ?? []) await cmd(`tickingarea add ${Array.isArray(t.box)?t.box.join(' '):t.box} ${t.name}`);
if ((spec.ticking ?? []).length) {
  const wait = spec.settleMs ?? 55000;
  log(`Added ${spec.ticking.length} ticking areas; waiting ${Math.round(wait / 1000)} seconds for chunks to load…`);
  await sleep(wait);
}
for (const line of spec.prelude ?? []) { try { await cmd(line); } catch (e) { log(`  prelude skipped "${line}": ${e.message}`); } }

// ---- 把遊戲叫到最前面，否則截到的是別的視窗 ----
spawnSync('open', ['-a', spec.app ?? 'minecraft-edu']);
await sleep(1200);

// ---- 逐格拍攝 ----
const shot = file => execFileSync('/usr/sbin/screencapture', ['-x', '-o', '-t', 'png', file]);
const t0 = Date.now(); let n = 0; const timings = [];
for (const p of plan) {
  const a = Date.now();
  await cmd(`tp @s ${p.pos.join(' ')} ${p.rot.join(' ')}`);
  await sleep(p.hold);
  shot(join(shotsDir, `${p.id}.png`));
  timings.push(Date.now() - a); n++;
  if (n % 10 === 0 || n === plan.length) log(`  ${n}/${plan.length}  average ${Math.round(timings.reduce((s, v) => s + v, 0) / timings.length)} ms/frame`);
}
for (const line of spec.postlude ?? []) { try { await cmd(line); } catch (e) { log(`  postlude skipped "${line}": ${e.message}`); } }
for (const t of spec.ticking ?? []) await cmd(`tickingarea remove ${t.name}`);
log(`Captured ${n} frames in ${Math.round((Date.now() - t0) / 1000)} seconds`);

// ---- 運鏡序列接成影片；minterpolate 把稀疏的格補成順的動態 ----
if (!has('--no-video')) for (const p of spec.paths ?? []) {
  const src = join(shotsDir, `${p.id}-%04d.png`);
  const mp4 = join(outDir, `${p.id}.mp4`);
  const fps = p.fps ?? 24;
  const r = spawnSync('/opt/homebrew/bin/ffmpeg', ['-y', '-framerate', String(fps), '-i', src,
    '-vf', `minterpolate=fps=60:mi_mode=mci:mc_mode=aobmc:vsbmc=1,scale=2560:-2:flags=lanczos`,
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '18', mp4], { encoding: 'utf8' });
  log(r.status === 0 ? `  video ${mp4}` : `  ffmpeg failed: ${(r.stderr ?? '').split('\n').slice(-4).join(' ')}`);
}
writeFileSync(join(outDir, 'timings.json'), JSON.stringify({ plan: plan.length, timings }, null, 1));
await client.close();
log('Done.');
