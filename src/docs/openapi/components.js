/** @type {import('openapi-types').OpenAPIV3.ComponentsObject} */
const components = {
  securitySchemes: {
    bearerAuth: {
      type: 'http',
      scheme: 'bearer',
      bearerFormat: 'JWT',
      description:
        'Admin dashboard: `Authorization: Bearer <token>` from login (`ei_admin_token` in localStorage). Required on most `/api/v1/*` routes.',
    },
  },
  schemas: {
    ErrorBody: {
      type: 'object',
      properties: {
        error: { type: 'string', example: 'Failed to fetch equipment' },
      },
      required: ['error'],
    },
    SuccessMessage: {
      type: 'object',
      properties: {
        message: { type: 'string', example: 'Equipment deleted' },
      },
    },
    ApiSuccessEnvelope: {
      type: 'object',
      properties: {
        success: { type: 'boolean', example: true },
        message: { type: 'string' },
        data: { type: 'object', additionalProperties: true },
      },
    },
    ApiSuccessFlag: {
      type: 'object',
      properties: {
        success: { type: 'boolean', example: true },
        created: { type: 'integer', example: 2 },
        repaired: { type: 'integer', example: 1 },
      },
    },
    MfgEquipment: {
      type: 'object',
      properties: {
        id: { type: 'string', example: 'MFG-01' },
        name: { type: 'string' },
        cap: { type: 'integer', nullable: true },
        type: { type: 'string' },
        homogenizer: { type: 'boolean' },
        processType: { type: 'array', items: { type: 'string' } },
        status: { type: 'string', example: 'idle' },
        _pk: { type: 'integer', description: 'Database primary key' },
      },
    },
    FillingEquipment: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        name: { type: 'string' },
        speed: { type: 'integer', nullable: true },
        type: { type: 'string' },
        compatible: { type: 'array', items: { type: 'string' } },
        status: { type: 'string' },
        _pk: { type: 'integer' },
      },
    },
    PackagingEquipment: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        name: { type: 'string' },
        speed: { type: 'integer', nullable: true },
        type: { type: 'string' },
        supports: { type: 'array', items: { type: 'string' } },
        status: { type: 'string' },
        _pk: { type: 'integer' },
      },
    },
    EquipmentGrouped: {
      type: 'object',
      properties: {
        manufacturing: { type: 'array', items: { $ref: '#/components/schemas/MfgEquipment' } },
        filling: { type: 'array', items: { $ref: '#/components/schemas/FillingEquipment' } },
        packaging: { type: 'array', items: { $ref: '#/components/schemas/PackagingEquipment' } },
      },
    },
    ProductionEquipmentCreate: {
      type: 'object',
      required: ['equipment_id', 'name', 'category', 'type'],
      properties: {
        equipment_id: { type: 'string', example: 'MFG-02' },
        name: { type: 'string' },
        category: { type: 'string', enum: ['manufacturing', 'filling', 'packaging'] },
        capacity: { type: 'integer', description: 'Manufacturing only' },
        speed: { type: 'integer', description: 'Filling / packaging' },
        type: { type: 'string' },
        homogenizer: { type: 'boolean' },
        process_types: { type: 'array', items: { type: 'string' } },
        compatible: { type: 'array', items: { type: 'string' } },
        supports: { type: 'array', items: { type: 'string' } },
        status: { type: 'string', default: 'idle' },
      },
    },
    ProductionEquipmentUpdate: {
      type: 'object',
      properties: {
        equipment_id: { type: 'string' },
        name: { type: 'string' },
        category: { type: 'string', enum: ['manufacturing', 'filling', 'packaging'] },
        capacity: { type: 'integer' },
        speed: { type: 'integer' },
        type: { type: 'string' },
        homogenizer: { type: 'boolean' },
        process_types: { type: 'array', items: { type: 'string' } },
        compatible: { type: 'array', items: { type: 'string' } },
        supports: { type: 'array', items: { type: 'string' } },
        status: { type: 'string' },
      },
    },
    TeamMember: {
      type: 'object',
      properties: {
        id: { type: 'string', example: 'TM-01' },
        userId: { type: 'integer', nullable: true },
        name: { type: 'string' },
        role: { type: 'string' },
        dept: { type: 'string', enum: ['Manufacturing', 'Filling', 'Packaging', 'Quality'] },
        avail: { type: 'boolean' },
        _pk: { type: 'integer' },
      },
    },
    TeamMemberCreate: {
      type: 'object',
      required: ['member_id', 'name', 'role', 'department'],
      properties: {
        member_id: { type: 'string' },
        user_id: { type: 'integer', nullable: true },
        name: { type: 'string' },
        role: { type: 'string' },
        department: { type: 'string', enum: ['Manufacturing', 'Filling', 'Packaging', 'Quality'] },
        available: { type: 'boolean', default: true },
      },
    },
    TeamMemberUpdate: {
      type: 'object',
      properties: {
        member_id: { type: 'string' },
        user_id: { type: 'integer', nullable: true },
        name: { type: 'string' },
        role: { type: 'string' },
        department: { type: 'string', enum: ['Manufacturing', 'Filling', 'Packaging', 'Quality'] },
        available: { type: 'boolean' },
      },
    },
    ProductionBatch: {
      type: 'object',
      description: 'BMR/BPR batch row (fields may be null when user lacks granular view permission).',
      properties: {
        _pk: { type: 'integer' },
        bmrNo: { type: 'string', nullable: true },
        bprNo: { type: 'string', nullable: true },
        productName: { type: 'string' },
        sku: { type: 'string' },
        soNo: { type: 'string' },
        orderQty: { type: 'integer' },
        batchSize: { type: 'integer' },
        batchNo: { type: 'string' },
        batchIndex: { type: 'integer' },
        totalBatches: { type: 'integer' },
        bmrStatus: { type: 'string' },
        bprStatus: { type: 'string' },
        color: { type: 'string' },
        processType: { type: 'string' },
        homogenizer: { type: 'boolean' },
        mainVessel: { type: 'string' },
        supportingTanks: { type: 'array', items: { type: 'string' } },
        fillingLine: { type: 'string' },
        fillingType: { type: 'string' },
        packagingLine: { type: 'string' },
        monocarton: { type: 'boolean' },
        shrink: { type: 'boolean' },
        teamBMR: { type: 'array', items: { type: 'object' } },
        teamBPR: { type: 'array', items: { type: 'object' } },
        qcOfficerBMR: { type: 'string' },
        qcOfficerBPR: { type: 'string' },
        scheduledMuZone: { type: 'string' },
        scheduleRemarks: { type: 'string' },
        rmReserved: { type: 'boolean' },
        pmReserved: { type: 'boolean' },
        rmConnected: { type: 'boolean' },
        pmConnected: { type: 'boolean' },
        dispensingRM: { type: 'array', items: { type: 'object' } },
        dispensingPM: { type: 'array', items: { type: 'object' } },
        bulkYield: { type: 'number', nullable: true },
        fillYield: { type: 'number', nullable: true },
        fgYield: { type: 'number', nullable: true },
        planningBatchId: { type: 'integer' },
        muDispensingBundleId: { type: 'string', nullable: true },
        muDispensingBundles: { type: 'array', items: { type: 'object' } },
      },
    },
    ProductionBatchWrite: {
      type: 'object',
      description:
        'Create/update body. Accepts snake_case DB fields and/or camelCase (see BATCH_CAMEL_TO_SNAKE in production controller).',
      additionalProperties: true,
      properties: {
        bmr_no: { type: 'string' },
        bpr_no: { type: 'string' },
        product_name: { type: 'string' },
        productName: { type: 'string' },
        sku: { type: 'string' },
        so_no: { type: 'string' },
        soNo: { type: 'string' },
        order_qty: { type: 'integer' },
        orderQty: { type: 'integer' },
        batch_size: { type: 'integer' },
        batchSize: { type: 'integer' },
        bmr_status: { type: 'string' },
        bmrStatus: { type: 'string' },
        bpr_status: { type: 'string' },
        bprStatus: { type: 'string' },
        dispensing_rm: { type: 'array', items: { type: 'object' } },
        dispensingRM: { type: 'array', items: { type: 'object' } },
        dispensing_pm: { type: 'array', items: { type: 'object' } },
        dispensingPM: { type: 'array', items: { type: 'object' } },
      },
    },
    CreateReworkBatchBody: {
      type: 'object',
      required: ['baseBatchId'],
      properties: {
        baseBatchId: { type: 'integer', description: 'Production batch `_pk` to rework from' },
        reason: { type: 'string' },
        targetOrderQty: { type: 'number' },
        targetBatchSizeKg: { type: 'number' },
        rmLines: { type: 'array', items: { type: 'object' } },
        pmLines: { type: 'array', items: { type: 'object' } },
      },
    },
    BatchBomResponse: {
      type: 'object',
      properties: {
        success: { type: 'boolean', example: true },
        data: {
          type: 'object',
          properties: {
            rmLines: { type: 'array', items: { type: 'object' } },
            pmLines: { type: 'array', items: { type: 'object' } },
            source: { type: 'string' },
            batchSizeKg: { type: 'number' },
            qcReference: {
              type: 'object',
              properties: {
                ingredientBulkSpecs: { type: 'array', items: { type: 'object' } },
                fgProductSpecs: { type: 'object' },
              },
            },
          },
        },
      },
    },
    BatchMtrReservedResponse: {
      type: 'object',
      properties: {
        success: { type: 'boolean', example: true },
        byCode: {
          type: 'object',
          additionalProperties: { type: 'number' },
          example: { 'RM-001': 12.5, 'PM-002': 100 },
        },
      },
    },
    BatchDispensingMuStockResponse: {
      type: 'object',
      properties: {
        success: { type: 'boolean', example: true },
        scheduledMuZone: { type: 'string' },
        byCode: {
          type: 'object',
          additionalProperties: { type: 'number' },
        },
      },
    },
  },
  responses: {
    Unauthorized: {
      description: 'Missing or invalid JWT',
    },
    Forbidden: {
      description: 'Authenticated but missing module or granular permission',
    },
    NotFound: {
      description: 'Resource not found',
      content: {
        'application/json': {
          schema: { $ref: '#/components/schemas/ErrorBody' },
        },
      },
    },
    ServerError: {
      description: 'Internal server error',
      content: {
        'application/json': {
          schema: { $ref: '#/components/schemas/ErrorBody' },
        },
      },
    },
  },
};

module.exports = { components };
