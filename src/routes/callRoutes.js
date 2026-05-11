import { buildCallController } from '../controllers/callController.js';

export function mountCallRoutes(app, orchestrator) {
  const c = buildCallController(orchestrator);
  app.post('/call', c.start);
}
