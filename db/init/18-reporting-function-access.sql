-- Private Grafana connects through a role that inherits pg_read_all_data.
-- Role bootstrap grants that login direct function access on a fresh volume,
-- but bootstrap scripts do not rerun when later migrations add functions.
-- Attach routine access to the stable read-only parent role as well so both
-- existing and future volumes retain the reporting contract.

GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA reporting TO pg_read_all_data;

ALTER DEFAULT PRIVILEGES FOR ROLE CURRENT_USER IN SCHEMA reporting
  GRANT EXECUTE ON FUNCTIONS TO pg_read_all_data;
