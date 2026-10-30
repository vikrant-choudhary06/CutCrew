ALTER TABLE progress ADD COLUMN observed_at timestamptz NOT NULL DEFAULT now();
