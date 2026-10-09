-- The neighborhood seed spelled names without diacritics (Obilicevo for
-- Obilićevo). Rename them to their Serbian Latin spelling; listings follow
-- through the foreign key, lifecycle snapshots are updated alongside.
BEGIN;
ALTER TABLE lean.listings
  DROP CONSTRAINT listings_neighborhood_fkey,
  ADD CONSTRAINT listings_neighborhood_fkey FOREIGN KEY (neighborhood)
    REFERENCES lean.neighborhoods(name) ON UPDATE CASCADE;

CREATE TEMP TABLE neighborhood_spelling (old text PRIMARY KEY, new text NOT NULL UNIQUE)
  ON COMMIT DROP;
INSERT INTO neighborhood_spelling VALUES
  ('Bocac', 'Bočac'),
  ('Borkovici', 'Borkovići'),
  ('Cesma', 'Česma'),
  ('Cokori', 'Čokori'),
  ('Dragocaj', 'Dragočaj'),
  ('Drakulic', 'Drakulić'),
  ('Golesi', 'Goleši'),
  ('Kmecani', 'Kmećani'),
  ('Kocicev Vijenac', 'Kočićev Vijenac'),
  ('Laus 1', 'Lauš 1'),
  ('Laus 2', 'Lauš 2'),
  ('Ljubacevo', 'Ljubačevo'),
  ('Misin Han', 'Mišin Han'),
  ('Nova Varos', 'Nova Varoš'),
  ('Obilicevo', 'Obilićevo'),
  ('Pavici', 'Pavići'),
  ('Petricevac', 'Petrićevac'),
  ('Pobrdje', 'Pobrđe'),
  ('Prijecani', 'Priječani'),
  ('Saracica', 'Saračica'),
  ('Sargovac', 'Šargovac'),
  ('Simani', 'Šimani'),
  ('Starcevica', 'Starčevica'),
  ('Stricici', 'Stričići'),
  ('Verici', 'Verići'),
  ('Zaluzani', 'Zalužani');

UPDATE lean.neighborhoods n SET name = s.new
  FROM neighborhood_spelling s WHERE n.name = s.old;
UPDATE lean.listing_lifecycle_events e SET neighborhood = s.new
  FROM neighborhood_spelling s WHERE e.neighborhood = s.old;

DO $$
BEGIN
  IF (SELECT count(*) FROM lean.neighborhoods) <> 56
     OR EXISTS (SELECT 1 FROM lean.neighborhoods n JOIN neighborhood_spelling s
                  ON n.name = s.old) THEN
    RAISE EXCEPTION 'neighborhood spelling migration failed validation';
  END IF;
END $$;
COMMIT;
