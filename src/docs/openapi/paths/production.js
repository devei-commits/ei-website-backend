const PRODUCTION_TAG = 'Production';
const PRODUCTION_SECURITY = [{ bearerAuth: [] }];
const PRODUCTION_AUTH_NOTE =
  'Requires JWT, `order-management` module, and granular permissions (production-bmr / production-bpr / production-transfer-yield).';

function idParam() {
  return {
    name: 'id',
    in: 'path',
    required: true,
    schema: { type: 'integer' },
    description: 'Database primary key (`_pk`)',
  };
}

/** @returns {Record<string, object>} */
function productionPaths(apiPrefix) {
  const base = `${apiPrefix}/production`;

  return {
    [`${base}/equipment`]: {
      get: {
        tags: [PRODUCTION_TAG],
        summary: 'List equipment (grouped)',
        description: `Admin: \`fetchEquipment()\`. ${PRODUCTION_AUTH_NOTE}`,
        security: PRODUCTION_SECURITY,
        responses: {
          200: {
            description: 'Equipment grouped by category',
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/EquipmentGrouped' } },
            },
          },
          401: { $ref: '#/components/responses/Unauthorized' },
          403: { $ref: '#/components/responses/Forbidden' },
          500: { $ref: '#/components/responses/ServerError' },
        },
      },
      post: {
        tags: [PRODUCTION_TAG],
        summary: 'Create equipment',
        description: `Admin: \`createEquipment(payload)\`. ${PRODUCTION_AUTH_NOTE} Write permission required.`,
        security: PRODUCTION_SECURITY,
        requestBody: {
          required: true,
          content: {
            'application/json': { schema: { $ref: '#/components/schemas/ProductionEquipmentCreate' } },
          },
        },
        responses: {
          201: {
            description: 'Created equipment',
            content: {
              'application/json': {
                schema: {
                  oneOf: [
                    { $ref: '#/components/schemas/MfgEquipment' },
                    { $ref: '#/components/schemas/FillingEquipment' },
                    { $ref: '#/components/schemas/PackagingEquipment' },
                  ],
                },
              },
            },
          },
          401: { $ref: '#/components/responses/Unauthorized' },
          403: { $ref: '#/components/responses/Forbidden' },
          500: { $ref: '#/components/responses/ServerError' },
        },
      },
    },
    [`${base}/equipment/{id}`]: {
      get: {
        tags: [PRODUCTION_TAG],
        summary: 'Get equipment by id',
        security: PRODUCTION_SECURITY,
        parameters: [idParam()],
        responses: {
          200: {
            description: 'Single equipment row',
            content: {
              'application/json': {
                schema: {
                  oneOf: [
                    { $ref: '#/components/schemas/MfgEquipment' },
                    { $ref: '#/components/schemas/FillingEquipment' },
                    { $ref: '#/components/schemas/PackagingEquipment' },
                  ],
                },
              },
            },
          },
          404: { $ref: '#/components/responses/NotFound' },
          500: { $ref: '#/components/responses/ServerError' },
        },
      },
      patch: {
        tags: [PRODUCTION_TAG],
        summary: 'Update equipment',
        security: PRODUCTION_SECURITY,
        parameters: [idParam()],
        requestBody: {
          required: true,
          content: {
            'application/json': { schema: { $ref: '#/components/schemas/ProductionEquipmentUpdate' } },
          },
        },
        responses: {
          200: {
            description: 'Updated equipment',
            content: {
              'application/json': {
                schema: {
                  oneOf: [
                    { $ref: '#/components/schemas/MfgEquipment' },
                    { $ref: '#/components/schemas/FillingEquipment' },
                    { $ref: '#/components/schemas/PackagingEquipment' },
                  ],
                },
              },
            },
          },
          404: { $ref: '#/components/responses/NotFound' },
          500: { $ref: '#/components/responses/ServerError' },
        },
      },
      delete: {
        tags: [PRODUCTION_TAG],
        summary: 'Delete equipment',
        security: PRODUCTION_SECURITY,
        parameters: [idParam()],
        responses: {
          200: {
            description: 'Deleted',
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/SuccessMessage' } },
            },
          },
          404: { $ref: '#/components/responses/NotFound' },
          500: { $ref: '#/components/responses/ServerError' },
        },
      },
    },

    [`${base}/team`]: {
      get: {
        tags: [PRODUCTION_TAG],
        summary: 'List production team members',
        description: 'Role-based list: active users with Super Admin, Admin, or Production roles. Admin: `fetchTeam()`.',
        security: PRODUCTION_SECURITY,
        responses: {
          200: {
            description: 'Team members',
            content: {
              'application/json': {
                schema: { type: 'array', items: { $ref: '#/components/schemas/TeamMember' } },
              },
            },
          },
          500: { $ref: '#/components/responses/ServerError' },
        },
      },
    },

    [`${base}/batches`]: {
      get: {
        tags: [PRODUCTION_TAG],
        summary: 'List production batches (BMR/BPR)',
        description: 'Admin: `fetchBatches()`. Response fields may be redacted based on granular permissions.',
        security: PRODUCTION_SECURITY,
        responses: {
          200: {
            content: {
              'application/json': {
                schema: { type: 'array', items: { $ref: '#/components/schemas/ProductionBatch' } },
              },
            },
          },
          500: { $ref: '#/components/responses/ServerError' },
        },
      },
      post: {
        tags: [PRODUCTION_TAG],
        summary: 'Create production batch',
        security: PRODUCTION_SECURITY,
        requestBody: {
          required: true,
          content: {
            'application/json': { schema: { $ref: '#/components/schemas/ProductionBatchWrite' } },
          },
        },
        responses: {
          201: {
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/ProductionBatch' } },
            },
          },
          500: { $ref: '#/components/responses/ServerError' },
        },
      },
    },
    [`${base}/batches/sync-from-planning`]: {
      post: {
        tags: [PRODUCTION_TAG],
        summary: 'Sync batches from planning (sent batches)',
        description: 'Creates missing production batches for planning rows with `sent_batch_indices`. No request body.',
        security: PRODUCTION_SECURITY,
        responses: {
          200: {
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/ApiSuccessFlag' } },
            },
          },
          500: {
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    success: { type: 'boolean', example: false },
                    error: { type: 'string' },
                  },
                },
              },
            },
          },
        },
      },
    },
    [`${base}/batches/create-rework`]: {
      post: {
        tags: [PRODUCTION_TAG],
        summary: 'Create rework batch from existing batch',
        security: PRODUCTION_SECURITY,
        requestBody: {
          required: true,
          content: {
            'application/json': { schema: { $ref: '#/components/schemas/CreateReworkBatchBody' } },
          },
        },
        responses: {
          201: {
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/ProductionBatch' } },
            },
          },
          400: {
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/ErrorBody' } },
            },
          },
          404: { $ref: '#/components/responses/NotFound' },
        },
      },
    },
    [`${base}/batches/{id}`]: {
      get: {
        tags: [PRODUCTION_TAG],
        summary: 'Get batch by id',
        security: PRODUCTION_SECURITY,
        parameters: [idParam()],
        responses: {
          200: {
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/ProductionBatch' } },
            },
          },
          400: {
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/ErrorBody' } },
            },
          },
          404: { $ref: '#/components/responses/NotFound' },
        },
      },
      patch: {
        tags: [PRODUCTION_TAG],
        summary: 'Update batch',
        description:
          'Partial update. PATCH body fields determine which granular edit permission is required (BMR / BPR / yield).',
        security: PRODUCTION_SECURITY,
        parameters: [idParam()],
        requestBody: {
          required: true,
          content: {
            'application/json': { schema: { $ref: '#/components/schemas/ProductionBatchWrite' } },
          },
        },
        responses: {
          200: {
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/ProductionBatch' } },
            },
          },
          403: { $ref: '#/components/responses/Forbidden' },
          404: { $ref: '#/components/responses/NotFound' },
        },
      },
      delete: {
        tags: [PRODUCTION_TAG],
        summary: 'Delete batch',
        security: PRODUCTION_SECURITY,
        parameters: [idParam()],
        responses: {
          200: {
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/SuccessMessage' } },
            },
          },
          404: { $ref: '#/components/responses/NotFound' },
        },
      },
    },
    [`${base}/batches/{id}/bom`]: {
      get: {
        tags: [PRODUCTION_TAG],
        summary: 'Batch BOM lines + QC reference',
        security: PRODUCTION_SECURITY,
        parameters: [idParam()],
        responses: {
          200: {
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/BatchBomResponse' } },
            },
          },
          404: { $ref: '#/components/responses/NotFound' },
        },
      },
    },
    [`${base}/batches/{id}/mtr-reserved`]: {
      get: {
        tags: [PRODUCTION_TAG],
        summary: 'Reserved qty per material code for batch',
        security: PRODUCTION_SECURITY,
        parameters: [idParam()],
        responses: {
          200: {
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/BatchMtrReservedResponse' } },
            },
          },
          404: { $ref: '#/components/responses/NotFound' },
        },
      },
    },
    [`${base}/batches/{id}/dispensing-mu-stock`]: {
      get: {
        tags: [PRODUCTION_TAG],
        summary: 'Stock at scheduled MU zone per RM/PM code',
        security: PRODUCTION_SECURITY,
        parameters: [idParam()],
        responses: {
          200: {
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    success: { type: 'boolean', example: true },
                    scheduledMuZone: { type: 'string' },
                    rmByCode: { type: 'object', additionalProperties: { type: 'string' } },
                    pmByCode: { type: 'object', additionalProperties: { type: 'string' } },
                  },
                },
              },
            },
          },
          404: { $ref: '#/components/responses/NotFound' },
        },
      },
    },
  };
}

module.exports = { productionPaths };
