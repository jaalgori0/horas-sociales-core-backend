/**
 * Logger mínimo sin dependencias. Formato: ISO-timestamp NIVEL mensaje.
 * Reemplazable por pino/winston sin cambiar la interfaz pública.
 */
import { env } from './config/env.js';

type Level = 'debug' | 'info' | 'warn' | 'error';

const PRIORITY: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const threshold = PRIORITY[env.LOG_LEVEL];

function write(level: Level, message: string, meta?: unknown): void {
  if (PRIORITY[level] < threshold) return;
  const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} ${message}`;
  const stream = level === 'error' || level === 'warn' ? console.error : console.log;
  if (meta === undefined) stream(line);
  else stream(line, meta);
}

export const logger = {
  debug: (message: string, meta?: unknown) => write('debug', message, meta),
  info: (message: string, meta?: unknown) => write('info', message, meta),
  warn: (message: string, meta?: unknown) => write('warn', message, meta),
  error: (message: string, meta?: unknown) => write('error', message, meta),
};
