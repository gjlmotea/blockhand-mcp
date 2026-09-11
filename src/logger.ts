type LogLevel = 'info' | 'error';

export function log(level: LogLevel, message: string, details?: Record<string, unknown>): void {
  const suffix = details === undefined ? '' : ` ${JSON.stringify(details)}`;
  process.stderr.write(`[minecraft-edu-mcp] ${level}: ${message}${suffix}\n`);
}
