/**
 * 協定探針：繞過 MCP 層，直接用 ws 收發，把遊戲回的每一個原始封包原封不動印出來。
 *
 * 用途是回答「遊戲到底回了什麼」，而不是「我們以為它回了什麼」。
 * 只在診斷協定行為時使用，不是產品路徑的一部分。
 */

import { randomUUID } from 'node:crypto';

import { WebSocketServer } from 'ws';

const PORT = Number.parseInt(process.env.MINECRAFT_EDU_WS_PORT ?? '19131', 10);

const PROBES = [
  'getlocalplayername',
  'querytarget @s',
  'querytarget @p',
  'querytarget @e[type=player]',
  'say protocol probe',
  'time query daytime',
  'testforblock ~ ~-1 ~ air',
  'agent create',
  'querytarget @e[type=agent]',
];

const server = new WebSocketServer({ host: '127.0.0.1', port: PORT });

process.stdout.write(`探針監聽 127.0.0.1:${PORT}\n請在遊戲聊天列輸入：/connect 127.0.0.1:${PORT}\n\n`);

const waitMs = Number.parseInt(process.env.PROBE_WAIT_SECONDS ?? '180', 10) * 1000;
const timeout = setTimeout(() => {
  process.stdout.write('\n逾時：沒有任何連線進來。\n');
  server.close();
  process.exit(1);
}, waitMs);

server.on('connection', async (socket) => {
  clearTimeout(timeout);
  process.stdout.write('=== 已連線 ===\n\n');

  const seen = [];
  socket.on('message', (data) => {
    const raw = data.toString();
    seen.push(raw);
    process.stdout.write(`<<< ${raw}\n\n`);
  });

  const send = (commandLine) =>
    new Promise((resolve) => {
      const requestId = randomUUID();
      const frame = {
        header: {
          version: 1,
          requestId,
          messageType: 'commandRequest',
          messagePurpose: 'commandRequest',
        },
        body: { version: 1, commandLine, origin: { type: 'player' } },
      };
      process.stdout.write(`>>> [${requestId.slice(0, 8)}] ${commandLine}\n`);
      socket.send(JSON.stringify(frame));
      setTimeout(resolve, 2500);
    });

  for (const commandLine of PROBES) {
    await send(commandLine);
  }

  // 順便看看訂閱事件會不會回應。
  process.stdout.write('>>> subscribe PlayerMessage\n');
  socket.send(
    JSON.stringify({
      header: {
        version: 1,
        requestId: randomUUID(),
        messageType: 'commandRequest',
        messagePurpose: 'subscribe',
      },
      body: { eventName: 'PlayerMessage' },
    }),
  );
  await new Promise((resolve) => setTimeout(resolve, 3000));

  process.stdout.write(`\n=== 共收到 ${seen.length} 個封包 ===\n`);
  socket.close();
  server.close();
  process.exit(0);
});
