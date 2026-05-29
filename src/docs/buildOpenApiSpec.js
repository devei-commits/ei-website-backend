const { components } = require('./openapi/components');
const { collectPaths } = require('./openapi/paths');

/**
 * @param {object} opts
 * @param {string} opts.apiPrefix - e.g. `/api/v1`
 * @param {number} [opts.port]
 */
function buildOpenApiSpec({ apiPrefix, port = 3000 }) {
  const localServer = `http://localhost:${port}`;
  const paths = collectPaths(apiPrefix);

  return {
    openapi: '3.0.3',
    info: {
      title: 'Esthetic Insights API',
      version: '1.0.0',
      description: [
        'REST API for EI Admin Dashboard and related clients.',
        '',
        '**Auth:** Most routes require `Authorization: Bearer <JWT>` from login.',
        '',
        '**Response shapes:** Production endpoints often return JSON directly; other modules may use `{ success, message, data }`. Schemas are documented per endpoint.',
        '',
        '**Expanding docs:** Add path modules under `src/docs/openapi/paths/` and register in `paths/index.js`.',
      ].join('\n'),
    },
    servers: [
      { url: localServer, description: 'Local development' },
      { url: '/', description: 'Current host (relative)' },
    ],
    tags: [
      { name: 'System', description: 'Health and meta' },
      { name: 'Production', description: 'BMR/BPR, equipment, team' },
    ],
    paths,
    components,
    security: [{ bearerAuth: [] }],
  };
}

module.exports = { buildOpenApiSpec };
