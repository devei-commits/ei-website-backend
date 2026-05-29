function healthPaths(apiPrefix) {
  return {
    [`${apiPrefix}/health`]: {
      get: {
        tags: ['System'],
        summary: 'Health check',
        description: 'No authentication required.',
        security: [],
        responses: {
          200: {
            description: 'API is up',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    status: { type: 'string', example: 'ok' },
                  },
                },
              },
            },
          },
        },
      },
    },
  };
}

module.exports = { healthPaths };
