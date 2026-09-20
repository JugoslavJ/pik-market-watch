-- Keep the legacy-data repair migration allowed to update append-only evidence
-- even when it is being introduced after migration 21 on an older volume.
-- The setting is local to the migrator transaction and is cleared on commit.
SELECT set_config('app.history_maintenance', 'migration', true);
