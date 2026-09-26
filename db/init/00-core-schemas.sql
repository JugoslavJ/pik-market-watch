-- Database schemas.
-- Canonical extensions and application schemas.
CREATE EXTENSION IF NOT EXISTS fuzzystrmatch;
CREATE EXTENSION IF NOT EXISTS postgis;

CREATE SCHEMA olap;

COMMENT ON SCHEMA olap IS
  'Physical dashboard marts. Only reporting refresh functions write here; dashboards read reporting views.';

CREATE SCHEMA reporting;

COMMENT ON SCHEMA reporting IS
  'Private stable reporting surface for Grafana and application readers.';
