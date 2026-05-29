const swaggerUi = require('swagger-ui-express');
const { buildOpenApiSpec } = require('./buildOpenApiSpec');

function isSwaggerEnabled() {
  if (process.env.SWAGGER_ENABLED === 'true') return true;
  if (process.env.SWAGGER_ENABLED === 'false') return false;
  return process.env.NODE_ENV !== 'production';
}

/**
 * Mount Swagger UI and raw OpenAPI JSON on the Express app.
 * @param {import('express').Express} app
 * @param {{ apiPrefix: string, port?: number }} opts
 */
function mountSwagger(app, { apiPrefix, port }) {
  if (!isSwaggerEnabled()) return;

  const spec = buildOpenApiSpec({ apiPrefix, port });
  const docsPath = '/api/docs';

  app.get(`${docsPath}/openapi.json`, (_req, res) => {
    res.json(spec);
  });

  app.use(
    docsPath,
    swaggerUi.serve,
    swaggerUi.setup(spec, {
      customSiteTitle: 'EI API Docs',
      swaggerOptions: {
        persistAuthorization: true,
        displayRequestDuration: true,
        filter: true,
        tryItOutEnabled: true,
      },
    })
  );

  console.log(`Swagger UI: http://localhost:${port || 3000}${docsPath}`);
}

module.exports = { mountSwagger, isSwaggerEnabled, buildOpenApiSpec };
