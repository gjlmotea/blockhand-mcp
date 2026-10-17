type LogLevel = 'info' | 'error';

export function log(level: LogLevel, message: string, details?: Record<string, unknown>): void {
  const suffix = details === undefined ? '' : ` ${JSON.stringify(details)}`;
  // 時間戳記：hub.log 沒有時間，就對不上使用者說「剛剛打字沒反應」是哪一刻。
  process.stderr.write(`${new Date().toISOString()} [minecraft-edu-mcp] ${level}: ${message}${suffix}\n`);
}
