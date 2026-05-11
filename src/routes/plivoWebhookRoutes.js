import { buildPlivoWebhookController } from '../controllers/plivoWebhookController.js';

export function mountPlivoRoutes(app, registry, orchestrator) {
  const p = buildPlivoWebhookController(registry, orchestrator);
  app.post('/plivo/webhook/answer', p.answer);
  app.post('/plivo/webhook/hangup', p.hangup);
}
