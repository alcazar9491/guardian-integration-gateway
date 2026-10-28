import { pino, type DestinationStream, type Logger } from 'pino';

export type { Logger };

export const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

export interface LoggerOptions {
  readonly level: LogLevel;
  readonly destination?: DestinationStream;
}

export function createLogger({ level, destination }: LoggerOptions): Logger {
  return pino(
    {
      level,
      base: { service: 'guardian-gateway' },
      timestamp: pino.stdTimeFunctions.isoTime,
      redact: {
        paths: ['req.headers.authorization', 'req.headers.cookie', 'body', '*.body'],
        censor: '[REDACTED]',
      },
    },
    destination,
  );
}
