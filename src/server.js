import http from 'http';
import { env, assertEnvForRuntime } from './config/env.js';
import { createHttpStack } from './routes/index.js';
import { attachPlivoMediaWs } from './websocket/plivoMediaWs.js';
import { log } from './utils/logger.js';

assertEnvForRuntime();

const { app, registry } = createHttpStack();
const server = http.createServer(app);

/** @type {ReturnType<typeof attachPlivoMediaWs>} */
const plivoWss = attachPlivoMediaWs(server, registry);

server.requestTimeout = 120_000;

server.listen(env.port, () => {
  log.info(`HTTP+WS gateway listening ${env.port}`);
  log.info(`BASE_URL=${env.baseUrl}`);
  log.info(`WS_BASE_URL=${env.wsBaseUrl}`);
});

function shutdown(signal) {
  log.warn(`Graceful shutdown (${signal})`);

  try {
    for (const sess of registry.snapshotSessions()) sess.destroy(signal);
  } catch (_) {}

  try {
    plivoWss.close();
  } catch (_) {}

  server.close(() => {
    log.warn('HTTP server stopped');
    process.exit(0);
  });

  setTimeout(() => process.exit(1), 10_000).unref();
}

process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));
