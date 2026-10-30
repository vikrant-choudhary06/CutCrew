-- Auto-save to Telegram: when a viewer watches a provider stream long enough,
-- the title is queued here. A background worker downloads it once and hands
-- the file to the normal import pipeline (video_assets / video_import_jobs).
--
-- One row per movie or episode, ever: the unique index is the duplicate check,
-- so the same title is never downloaded twice in parallel or queued twice.
CREATE TABLE auto_archive_requests (
  id uuid PRIMARY KEY,
  imdb_id text NOT NULL CHECK (imdb_id ~ '^tt[0-9]{5,12}$'),
  season integer,
  episode integer,
  CHECK ((season IS NULL AND episode IS NULL) OR (season >= 0 AND episode >= 1)),
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','done','skipped','failed')),
  -- Short machine code only (why it was skipped or failed). Never a URL or message.
  reason text CHECK (reason IS NULL OR reason ~ '^[A-Z0-9_]{1,64}$'),
  -- The encrypted media token of the stream the viewer watched (expires within hours).
  source_token text CHECK (source_token IS NULL OR length(source_token) <= 16000),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_run_at timestamptz NOT NULL DEFAULT now(),
  lease_owner text CHECK (lease_owner IS NULL OR length(lease_owner) <= 100),
  lease_expires_at timestamptz,
  -- Set when a download actually starts; the daily limit counts these.
  download_started_at timestamptz,
  asset_id uuid REFERENCES video_assets(id) ON DELETE SET NULL,
  progress jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(progress) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX auto_archive_one_per_title ON auto_archive_requests
  (imdb_id, (COALESCE(season, -1)), (COALESCE(episode, -1)));
CREATE INDEX auto_archive_due ON auto_archive_requests (next_run_at) WHERE status IN ('queued','running');
CREATE INDEX auto_archive_started ON auto_archive_requests (download_started_at) WHERE download_started_at IS NOT NULL;
