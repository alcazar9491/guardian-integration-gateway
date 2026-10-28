import { compose } from './composition-root.js';
import { ConfigError, loadConfig, type AppConfig } from './shared/config/app-config.js';
import { createLogger } from './shared/logging/logger.js';

const SHUTDOWN_TIMEOUT_MS = 10_000;

function readConfigOrExit(): AppConfig {
  try {
    return loadConfig(process.env);
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error(error.message);
      process.exit(1);
    }
    throw error;
  }
}

const config = readConfigOrExit();
const logger = createLogger({ level: config.log.level });
const { app, shutdown: drainResources } = compose(config, logger);

const server = app.listen(config.http.port, (error?: Error) => {
  if (error) {
    logger.fatal({ err: error }, 'Failed to start server');
    process.exit(1);
  }
  logger.info({ port: config.http.port, env: config.env }, 'Guardian Gateway listening');
});

function shutdown(signal: NodeJS.Signals): void {
  logger.info({ signal }, 'Shutting down');
  server.close((error) => {
    if (error) {
      logger.error({ err: error }, 'Graceful shutdown failed');
      process.exit(1);
    }
    // No new requests can arrive now; wait for audit records already in flight before exiting.
    drainResources().then(
      () => process.exit(0),
      (drainError: unknown) => {
        logger.error({ err: drainError }, 'Failed to drain pending audit writes');
        process.exit(1);
      },
    );
  });
  setTimeout(() => {
    logger.warn('Forcing shutdown after timeout');
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS).unref();
}

process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
