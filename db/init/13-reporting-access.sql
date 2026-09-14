-- Stable reporting routine access for the read-only parent role.

GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA reporting TO pg_read_all_data;
ALTER DEFAULT PRIVILEGES FOR ROLE CURRENT_USER IN SCHEMA reporting
  GRANT EXECUTE ON FUNCTIONS TO pg_read_all_data;
