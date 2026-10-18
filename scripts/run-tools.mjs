/**
 * 照 JSON 劇本依序呼叫工具。
 *
 * 用途是在沒有 MCP Host 的情況下驅動這個 server——腳本化建造、示範、
 * 重現特定情境。它走的是完全相同的 MCP 工具面，不是繞過去的後門。
 *
 * 用法：
 *   node scripts/run-tools.mjs <plan.json>
 *
 * plan.json：
 *   {
 *     "waitSeconds": 300,
 *     "calls": [
 *       { "tool": "mc_query_target", "args": { "target": "@p" } },
 *       { "tool": "mc_build_shape", "args": { … }, "timeoutMs": 300000 }
 *     ]
 *   }
 *
 * 每一步印出摘要；任何一步失敗都會標記，但預設繼續往下跑，
 * 因為部分失敗（例如方塊已存在）常常不是中止的理由。
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { getDefaultEnvironment, StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const planPath = process.argv[2];
if (planPath === undefined) {
  process.stderr.write('Usage: node scripts/run-tools.mjs <plan.json>\n');
  process.exit(2);
}

const plan = JSON.parse(readFileSync(planPath, 'utf8'));
const projectRoot = fileURLToPath(new URL('..', import.meta.url));
const preferredPort = process.env.MINECRAFT_EDU_WS_PORT ?? '19131';
const DEFAULT_TIMEOUT_MS = 120_000;

const transport = new StdioClientTransport({
  command: process.execPath,
  args: ['scripts/launch-mcp.mjs'],
  cwd: projectRoot,
  stderr: 'pipe',
  env: {
    ...getDefaultEnvironment(),
    MINECRAFT_EDU_WS_HOST: '127.0.0.1',
    MINECRAFT_EDU_WS_PORT: preferredPort,
    ...(process.env.MINECRAFT_EDU_WS_PORT_FALLBACK === undefined
      ? {}
      : { MINECRAFT_EDU_WS_PORT_FALLBACK: process.env.MINECRAFT_EDU_WS_PORT_FALLBACK }),
    ...(process.env.MINECRAFT_EDU_DEBUG_FRAMES === undefined
      ? {}
      : { MINECRAFT_EDU_DEBUG_FRAMES: process.env.MINECRAFT_EDU_DEBUG_FRAMES }),
  },
});

const client = new Client({ name: 'minecraft-edu-runner', version: '1.0.0' });
let failures = 0;

function summary(result) {
  return result?.content?.[0]?.text ?? '(no summary)';
}

try {
  await client.connect(transport);

  const status = await client.callTool({ name: 'mc_status', arguments: {} });
  if (status.structuredContent?.connected !== true) {
    process.stdout.write(
      `\nThe bridge is listening. Type this into the game chat:\n\n    ${status.structuredContent?.connectCommand}\n\nWaiting for the connection…\n\n`,
    );
    if (plan.autoConnect === true) {
      process.stdout.write(
        '  · autoConnect is disabled: BlockHand never touches the foreground window or keyboard, so type the command above yourself.\n\n',
      );
    }

    const waitSeconds = plan.waitSeconds ?? 300;
    const deadline = Date.now() + waitSeconds * 1000;
    let connected = false;
    while (Date.now() < deadline) {
      const attempt = await client.callTool({
        name: 'mc_await_connection',
        arguments: { timeoutSeconds: 45 },
      });
      if (attempt.structuredContent?.connected === true) {
        connected = true;
        break;
      }
    }
    if (!connected) {
      process.stdout.write('Not connected within the time limit; stopping.\n');
      process.exitCode = 1;
      throw new Error('not-connected');
    }
  }

  const ready = await client.callTool({ name: 'mc_status', arguments: {} });
  process.stdout.write(
    `Connected (encrypted: ${ready.structuredContent?.encrypted === true ? 'yes' : 'no'})\n\n`,
  );

  for (const [index, step] of (plan.calls ?? []).entries()) {
    const label = `[${String(index + 1).padStart(2, '0')}] ${step.tool}`;
    let result;
    try {
      result = await client.callTool(
        { name: step.tool, arguments: step.args ?? {} },
        undefined,
        { timeout: step.timeoutMs ?? DEFAULT_TIMEOUT_MS },
      );
    } catch (error) {
      failures += 1;
      process.stdout.write(`${label}  ✗ call failed: ${error instanceof Error ? error.message : String(error)}\n`);
      continue;
    }

    // isError 只代表「工具本身出錯」。遊戲把指令拒絕或逾時是 isError=false
    // 但 structuredContent.ok=false——只看 isError 會把失敗報成成功。
    const structured = result.structuredContent;
    const gameRejected = structured !== undefined && structured.ok === false;

    if (result.isError === true || gameRejected) {
      failures += 1;
      process.stdout.write(`${label}  ✗ ${summary(result)}\n`);
      continue;
    }
    process.stdout.write(`${label}  ✓ ${summary(result)}\n`);
  }

  process.stdout.write(
    `\n───────────────\n${String((plan.calls ?? []).length - failures)}/${String((plan.calls ?? []).length)} steps succeeded\n`,
  );
  if (failures > 0) process.exitCode = 1;
} finally {
  await client.close();
}
