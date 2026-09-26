import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import type { BlockHandService } from '../../application/blockhand-service.js';
import { DEFAULT_UNDO_BLOCKS, MAX_UNDO_BLOCKS } from '../../domain/build/undo-plan.js';
import {
  batchOutcomeSchema,
  commandOutcomeSchema,
  connectionStatusSchema,
  undoStatusSchema,
} from '../schemas.js';
import { batchToPayload, guard, ok, outcomeToPayload, summarizeBatch, summarizeOutcome } from '../tool-kit.js';

export function registerSessionTools(server: McpServer, service: BlockHandService): void {
  server.registerTool('mc_undo_control', {
    title:'查看或設定單步復原',
    description:`注意：自動 Undo 預設關閉。在 Education 1.26.x 上開啟後，第一次建造前的原生檢查會讓遊戲的指令通道永久不回應（玩家打字也沒反應），只能重開 Minecraft；只在使用者明確要求時才 configure enabled=true。action=status 只讀取自動 Undo 狀態與耗時；configure 可開關及調整格數預算（預設${DEFAULT_UNDO_BLOCKS}、上限${MAX_UNDO_BLOCKS}）；依相同材質合併整區保存、原生整區比對。clear 釋放本服務的備份。只使用遊戲 memory，沒有磁碟備份或 Redo。關閉自動備份會清除舊歷史。`,
    inputSchema:z.object({action:z.enum(['status','configure','clear']).default('status'),enabled:z.boolean().optional(),maxBlocks:z.number().int().min(1).max(MAX_UNDO_BLOCKS).optional()}).strict(),
    outputSchema:undoStatusSchema(),
    annotations:{readOnlyHint:false,idempotentHint:true,destructiveHint:true,openWorldHint:false},
  },async({action,enabled,maxBlocks})=>guard(async()=>{
    if(!service.undo) throw new Error('此執行環境未配置 Undo。');
    if(action!=='configure'&&(enabled!==undefined||maxBlocks!==undefined)) throw new Error('enabled/maxBlocks 只適用於 configure。');
    const result=action==='status'?service.undo.status():await service.undo.configure(enabled,maxBlocks,action==='clear');
    return ok({...result},result.reason??`Undo ${result.enabled?'已開啟':'已停用'}，目前${result.available?'可復原':'沒有可直接復原的操作'}。`);
  }));
  server.registerTool('mc_undo', {
    title:'復原上一次建造',
    description:'復原最後一次受保護的 setblock/fill 或建造工具呼叫；多條建造指令算一步。先檢查所有目標方塊，再逐區以條件指令還原，避免覆蓋後來的修改。operationId 可防止復原錯誤版本。overwriteChanges 只在使用者明確要求覆蓋衝突或接受不確定操作的現場復原時使用，不能自動設為true。第一版只有主世界基本建材，不含生物、背包、區域外水流/機關連鎖或 Redo；操作期間請勿切換世界/維度。',
    inputSchema:z.object({operationId:z.string().min(1).optional(),overwriteChanges:z.boolean().default(false)}).strict(),
    outputSchema:undoStatusSchema(),
    annotations:{readOnlyHint:false,idempotentHint:false,destructiveHint:true,openWorldHint:false},
  },async({operationId,overwriteChanges})=>guard(async()=>{
    if(!service.undo) throw new Error('此執行環境未配置 Undo。');
    const result=await service.undo.undo(operationId,overwriteChanges);
    return ok({...result},result.reason??'復原完成。');
  }));
  server.registerTool(
    'mc_status',
    {
      title: '讀取橋接與連線狀態',
      description:
        '回報 WebSocket 橋接、遊戲指令回應狀態（commandState）、最近回覆／逾時時間、/connect 指令與已訂閱事件。connected 只代表網路連線；timed-out 表示最近有指令未回覆，不能據此假定遊戲仍可執行操作。無副作用。',
      inputSchema: z.object({}).strict(),
      outputSchema: connectionStatusSchema(),
      annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: false },
    },
    async () =>
      guard(async () => {
        const status = service.status();
        const saved = service.savedStructures();
        return ok(
          { ...status, savedStructures: saved, ...(service.undo ? {undo: {...service.undo.status()}} : {}) },
          status.connected
            ? (status.commandState === 'timed-out'
                ? '網路已連上，但最近指令未獲回覆；尚未確認遊戲可執行操作。'
                : `已連線（第 ${String(status.connectionCount)} 次），累計送出 ${String(status.commandsIssued)} 條指令。`) +
              (saved.length === 0
                ? ''
                : `本次存過的結構：${saved.map((entry) => `${entry.name}（${entry.saveMode}）`).join('、')}。`)
            : `尚未連線。請在 Minecraft Education 聊天列輸入：${status.connectCommand}（世界必須開啟作弊／Cheats）。`,
        );
      }),
  );

  server.registerTool(
    'mc_await_connection',
    {
      title: '等待 Minecraft 連入',
      description:
        '阻塞等待遊戲連上橋接，最多等 timeoutSeconds 秒。逾時不算錯誤，只是回報 connected=false。適合在請使用者輸入 /connect 之後呼叫。',
      inputSchema: z
        .object({ timeoutSeconds: z.number().int().min(1).max(120).default(30) })
        .strict(),
      outputSchema: connectionStatusSchema(),
      annotations: { readOnlyHint: true, idempotentHint: false, destructiveHint: false, openWorldHint: false },
    },
    async ({ timeoutSeconds }) =>
      guard(async () => {
        const status = await service.awaitConnection(timeoutSeconds * 1000);
        return ok(
          { ...status, savedStructures: service.savedStructures(), ...(service.undo ? {undo: {...service.undo.status()}} : {}) },
          status.connected
            ? status.commandState === 'timed-out'
              ? '網路已連上，但最近指令未獲回覆；請先確認遊戲畫面與回應狀態。'
              : 'Minecraft 已連上橋接。'
            : `等待 ${String(timeoutSeconds)} 秒後仍未連上。請確認遊戲內已輸入 ${status.connectCommand}，且世界開啟了作弊。`,
        );
      }),
  );

  server.registerTool(
    'mc_run_command',
    {
      title: '執行單一 slash 指令',
      description:
        '送出一條原始 slash 指令，涵蓋本 server 沒有專用工具的功能。只接受單行、不得換行串接，並拒絕 wsserver／connect（那會切斷本橋接）。前導斜線可有可無。',
      inputSchema: z
        .object({
          command: z.string().min(1).max(1024).describe('例如 "time set day" 或 "/give @s diamond 1"'),
        })
        .strict(),
      outputSchema: commandOutcomeSchema().extend({ risk: z.string() }).strict(),
      annotations: { readOnlyHint: false, idempotentHint: false, destructiveHint: true, openWorldHint: false },
    },
    async ({ command }) =>
      guard(async () => {
        const assessment = service.assessRaw(command);
        const outcome = await service.run(assessment.commandLine);
        return ok(
          { ...outcomeToPayload(outcome), risk: assessment.risk },
          summarizeOutcome(outcome),
        );
      }),
  );

  server.registerTool(
    'mc_run_commands',
    {
      title: '依序執行多條 slash 指令',
      description:
        '照順序送出多條原始指令，每條都各自通過政策檢查。適合手動編排的巨集；大量方塊請改用 mc_build_shape 或 mc_build_blueprint，它們會自動合併成最少的 fill。',
      inputSchema: z
        .object({
          commands: z.array(z.string().min(1).max(1024)).min(1).max(200),
          stopOnError: z.boolean().default(true),
          delayMs: z.number().int().min(0).max(5000).default(0),
          reportFailuresOnly: z
            .boolean()
            .default(false)
            .describe(
              '只回傳失敗的那幾條，成功的略過。大批次（例如 200 條 fill）的逐條結果動輒上萬 token，' +
                '而且多半只是「已填滿 N 個方塊」；批次很大又不需要逐條數字時開這個。issued／succeeded／failed 的統計不受影響。',
            ),
        })
        .strict(),
      outputSchema: batchOutcomeSchema(),
      annotations: { readOnlyHint: false, idempotentHint: false, destructiveHint: true, openWorldHint: false },
    },
    async ({ commands, stopOnError, delayMs, reportFailuresOnly }) =>
      guard(async () => {
        const normalized = commands.map((command) => service.assessRaw(command).commandLine);
        const batch = await service.runMany(normalized, { stopOnError, delayMs });
        // 逐條結果在 200 條的批次裡動輒上萬 token，過濾發生在轉 payload「之前」，
        // 統計欄位仍取自完整的 batch，所以 issued／succeeded／failed 不會因此失真。
        const reported = reportFailuresOnly
          ? { ...batch, outcomes: batch.outcomes.filter((outcome) => !outcome.ok) }
          : batch;
        return ok(batchToPayload(reported), summarizeBatch(batch, '批次指令'));
      }),
  );
}
