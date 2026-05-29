const { healthPaths } = require('./health');
const { productionPaths } = require('./production');

/**
 * Merge OpenAPI path objects from domain modules.
 * Add new modules here: require('./warehouse') etc.
 */
function collectPaths(apiPrefix) {
  return {
    ...healthPaths(apiPrefix),
    ...productionPaths(apiPrefix),
  };
}

module.exports = { collectPaths };
