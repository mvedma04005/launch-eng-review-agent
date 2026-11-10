import pino from 'pino';

export const log = pino({
  level: process.env['FALCON_LOG_LEVEL'] ?? 'info',
  base: { service: 'falcon-review-engine' },
  redact: { paths: ['token', 'privateKey', 'apiKey', '*.token', '*.authorization'], censor: '[redacted]' },
});
export type Logger = typeof log;
