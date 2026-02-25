-- Module definitions table: stores the full permission UI tree (modules + globalSettings) as JSON.
-- Used by GET /api/v1/roles/module-definitions; filtered by user role via roles + permissions + role_permissions.
-- Run this if your DB does not use Sequelize sync (e.g. production with existing schema).

-- PostgreSQL
CREATE TABLE IF NOT EXISTS module_definitions (
  id SERIAL PRIMARY KEY,
  name VARCHAR(100) NOT NULL DEFAULT 'default',
  definition_json JSONB NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- MySQL (if applicable)
-- CREATE TABLE IF NOT EXISTS module_definitions (
--   id INT AUTO_INCREMENT PRIMARY KEY,
--   name VARCHAR(100) NOT NULL DEFAULT 'default',
--   definition_json JSON NOT NULL,
--   created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
--   updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
-- );
