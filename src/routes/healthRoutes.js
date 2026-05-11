import { buildHealthController } from '../controllers/healthController.js';

export function mountHealthRoutes(app, registry) {
  const h = buildHealthController(registry);
  app.get('/health/live', h.live);
  app.get('/health/ready', h.ready);
}
