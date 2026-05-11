import express from 'express';
import { SessionRegistry } from '../services/sessionRegistry.js';
import { CallOrchestrator } from '../services/callOrchestrator.js';
import { mountCallRoutes } from './callRoutes.js';
import { mountPlivoRoutes } from './plivoWebhookRoutes.js';
import { mountHealthRoutes } from './healthRoutes.js';
import { mountSwaggerRoutes } from './swaggerRoutes.js';

/**
 * @param {CallOrchestrator} orchestrator
 * @param {SessionRegistry} registry
 */
export function buildApp(orchestrator, registry) {
  const app = express();
  app.set('trust proxy', 1);
  app.disable('x-powered-by');

  app.use(express.json({ limit: '32kb' }));
  app.use(express.urlencoded({ extended: true, limit: '32kb' }));

  mountSwaggerRoutes(app);
  mountHealthRoutes(app, registry);
  mountCallRoutes(app, orchestrator);
  mountPlivoRoutes(app, registry, orchestrator);

  app.use((_req, res) => {
    res.status(404).json({ error: 'not_found' });
  });

  app.use((err, _req, res, _next) => {
    console.error(err);
    res.status(500).json({ error: 'internal_error' });
  });

  return app;
}

/**
 * @returns {{ app: express.Express, orchestrator: CallOrchestrator, registry: SessionRegistry }}
 */
export function createHttpStack() {
  const registry = new SessionRegistry();
  registry.startJanitor();
  const orchestrator = new CallOrchestrator(registry);
  const app = buildApp(orchestrator, registry);
  return { app, orchestrator, registry };
}

