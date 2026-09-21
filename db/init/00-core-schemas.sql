-- Database schemas.
--
-- Canonical extensions and application schemas.
CREATE EXTENSION IF NOT EXISTS fuzzystrmatch;
CREATE EXTENSION IF NOT EXISTS postgis;

CREATE SCHEMA olap;

COMMENT ON SCHEMA olap IS
  'Physical dashboard marts. Only reporting refresh functions write here; dashboards read reporting views.';

--
-- Name: olap; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA reporting;

--
-- Name: reporting; Type: SCHEMA; Schema: -; Owner: -
--

COMMENT ON SCHEMA reporting IS
  'Private stable reporting surface for Grafana and application readers.';
