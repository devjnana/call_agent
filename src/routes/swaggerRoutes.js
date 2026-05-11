import swaggerUi from 'swagger-ui-express';
import { getOpenApiSpec } from '../openapi/spec.js';

/**
 * Swagger UI at `/docs`, raw spec at `/openapi.json`.
 */
export function mountSwaggerRoutes(app) {
  const spec = getOpenApiSpec();

  app.use(
    '/docs',
    swaggerUi.serve,
    swaggerUi.setup(spec, {
      customSiteTitle: 'Voice Translation Engine API',
      customCss: '.swagger-ui .topbar { display: none }',
    }),
  );

  app.get('/openapi.json', (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json(getOpenApiSpec());
  });
}
