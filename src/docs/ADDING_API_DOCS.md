# Adding API documentation (Swagger / OpenAPI)

Interactive docs: **http://localhost:3000/api/docs** (when the server is running and Swagger is enabled).

Raw spec: **http://localhost:3000/api/docs/openapi.json**

## Enable / disable

| Environment | Default |
|-------------|---------|
| `NODE_ENV !== 'production'` | Swagger **on** |
| `NODE_ENV === 'production'` | Swagger **off** |
| `SWAGGER_ENABLED=true` | Force **on** |
| `SWAGGER_ENABLED=false` | Force **off** |

## Add a new API module

1. Create `src/docs/openapi/paths/<module>.js` exporting a function `(apiPrefix) => pathsObject`.
2. Register it in `src/docs/openapi/paths/index.js`.
3. Add shared schemas to `src/docs/openapi/components.js` if reused.
4. Add a `tags` entry in `src/docs/buildOpenApiSpec.js` if needed.

Mirror the real controller: request body fields, status codes, and the exact JSON returned (not every endpoint uses `{ success, data }`).

## Try it out

1. Log in via the admin app (or auth API) and copy the JWT.
2. Open `/api/docs` → **Authorize** → `Bearer <token>`.
3. Execute endpoints against your running server.

## Reference: Production module

Fully documented in `openapi/paths/production.js` — use as a template for warehouse, MRN, procurement, etc.
