-- Canonical schemas baseline.
--
-- Name: dashboard_public; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA dashboard_public;

--
-- Name: SCHEMA dashboard_public; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON SCHEMA dashboard_public IS 'Allowlisted, read-only reporting surface for externally shared Grafana dashboards.';

--
-- Name: olap; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA olap;

--
-- Name: SCHEMA olap; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON SCHEMA olap IS 'Physical dashboard marts. Only reporting refresh functions write here; dashboards read reporting views.';

--
-- Name: reporting; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA reporting;

--
-- Name: SCHEMA reporting; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON SCHEMA reporting IS 'Private stable reporting surface; public dashboards use dashboard_public instead.';
