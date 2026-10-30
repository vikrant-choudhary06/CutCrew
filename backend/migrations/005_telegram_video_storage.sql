-- Telegram video storage index (telegramintegration.md, Phase 1).
-- Video bytes live in Telegram; these tables only describe them.
-- Triggers enforce exact byte layout and atomic Ready publication so that a
-- partially uploaded or inconsistent asset can never be selected for playback.

CREATE TABLE video_assets (
  id uuid PRIMARY KEY,                                   -- Upload ID
  schema_version smallint NOT NULL DEFAULT 1 CHECK (schema_version = 1),
  imdb_id text NOT NULL CHECK (imdb_id ~ '^tt[0-9]{5,12}$'),
  content_type text NOT NULL CHECK (content_type IN ('movie','episode')),
  season integer,
  episode integer,
  title text CHECK (title IS NULL OR length(title) BETWEEN 1 AND 300),
  release_year integer CHECK (release_year IS NULL OR release_year BETWEEN 1870 AND 2200),
  episode_release_year integer CHECK (episode_release_year IS NULL OR episode_release_year BETWEEN 1870 AND 2200),
  quality text NOT NULL CHECK (quality ~ '^[A-Za-z0-9]{1,16}$'),
  edition text NOT NULL DEFAULT 'original' CHECK (edition ~ '^[a-z0-9][a-z0-9-]{0,39}$'),
  audio_languages text[] NOT NULL DEFAULT '{}',
  tracks jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(tracks) = 'object'),
  file_name text CHECK (file_name IS NULL OR length(file_name) BETWEEN 1 AND 255),
  container text CHECK (container IS NULL OR length(container) BETWEEN 1 AND 32),
  video_codec text CHECK (video_codec IS NULL OR length(video_codec) BETWEEN 1 AND 32),
  audio_codec text CHECK (audio_codec IS NULL OR length(audio_codec) BETWEEN 1 AND 32),
  pixel_format text CHECK (pixel_format IS NULL OR length(pixel_format) BETWEEN 1 AND 32),
  width integer CHECK (width IS NULL OR width > 0),
  height integer CHECK (height IS NULL OR height > 0),
  duration_seconds double precision CHECK (duration_seconds IS NULL OR duration_seconds > 0),
  faststart boolean,
  transcoded boolean,
  total_size bigint CHECK (total_size IS NULL OR total_size > 0),
  sha256 text CHECK (sha256 IS NULL OR sha256 ~ '^[0-9a-f]{64}$'),
  part_size bigint CHECK (part_size IS NULL OR part_size > 0),
  part_count integer CHECK (part_count IS NULL OR part_count > 0),
  state text NOT NULL DEFAULT 'pending' CHECK (state IN
    ('pending','validating','preparing','uploading','verifying','ready','failed','unavailable','superseded')),
  is_default boolean NOT NULL DEFAULT false,
  failure_reason text CHECK (failure_reason IS NULL OR failure_reason ~ '^[A-Z0-9_]{1,64}$'),
  state_changed_at timestamptz NOT NULL DEFAULT now(),
  ready_at timestamptz,
  last_validated_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- Movie versus episode identity.
  CONSTRAINT video_assets_identity CHECK (
    (content_type = 'movie' AND season IS NULL AND episode IS NULL AND episode_release_year IS NULL) OR
    (content_type = 'episode' AND season >= 0 AND episode >= 1)),
  -- Audio language codes are lowercase, unique and sorted by the repository.
  CONSTRAINT video_assets_audio CHECK (cardinality(audio_languages) <= 16),
  -- The prepared-file description is all-or-nothing.
  CONSTRAINT video_assets_layout_complete CHECK (
    (total_size IS NULL AND sha256 IS NULL AND part_size IS NULL AND part_count IS NULL) OR
    (total_size IS NOT NULL AND sha256 IS NOT NULL AND part_size IS NOT NULL AND part_count IS NOT NULL)),
  -- Exact split rule: part_count = ceil(total_size / part_size).
  CONSTRAINT video_assets_part_count CHECK (
    part_count IS NULL OR part_count = (total_size + part_size - 1) / part_size),
  CONSTRAINT video_assets_layout_required CHECK (
    state IN ('pending','validating','preparing','failed') OR total_size IS NOT NULL),
  CONSTRAINT video_assets_ready_time CHECK (state <> 'ready' OR ready_at IS NOT NULL),
  CONSTRAINT video_assets_default_ready CHECK (NOT is_default OR state = 'ready')
);

-- At most one ready asset and one in-progress import per exact variant.
CREATE UNIQUE INDEX video_assets_one_ready_variant ON video_assets
  (imdb_id, COALESCE(season, -1), COALESCE(episode, -1), quality, edition, audio_languages)
  WHERE state = 'ready';
CREATE UNIQUE INDEX video_assets_one_active_variant ON video_assets
  (imdb_id, COALESCE(season, -1), COALESCE(episode, -1), quality, edition, audio_languages)
  WHERE state IN ('pending','validating','preparing','uploading','verifying');
CREATE UNIQUE INDEX video_assets_one_default ON video_assets
  (imdb_id, COALESCE(season, -1), COALESCE(episode, -1)) WHERE is_default;
CREATE INDEX video_assets_lookup ON video_assets (imdb_id, season, episode, state);

CREATE TABLE video_parts (
  asset_id uuid NOT NULL REFERENCES video_assets(id) ON DELETE CASCADE,
  part_number integer NOT NULL CHECK (part_number >= 1),
  byte_offset bigint NOT NULL CHECK (byte_offset >= 0),
  size bigint NOT NULL CHECK (size > 0),
  sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  integrity_manifest jsonb CHECK (integrity_manifest IS NULL OR jsonb_typeof(integrity_manifest) = 'object'),
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','uploaded','verified','missing')),
  telegram_chat_id bigint CHECK (telegram_chat_id IS NULL OR telegram_chat_id < -1000000000000),
  telegram_message_id bigint CHECK (telegram_message_id IS NULL OR telegram_message_id > 0),
  message_link text CHECK (message_link IS NULL OR message_link ~ '^https://t\.me/c/[0-9]+/[0-9]+$'),
  bot_file_id text CHECK (bot_file_id IS NULL OR length(bot_file_id) BETWEEN 1 AND 255),
  bot_file_unique_id text CHECK (bot_file_unique_id IS NULL OR length(bot_file_unique_id) BETWEEN 1 AND 64),
  mtproto_document_id text CHECK (mtproto_document_id IS NULL OR mtproto_document_id ~ '^-?[0-9]{1,20}$'),
  reference_refreshed_at timestamptz,
  uploaded_at timestamptz,
  verified_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (asset_id, part_number),
  CONSTRAINT video_parts_message_pair CHECK ((telegram_chat_id IS NULL) = (telegram_message_id IS NULL)),
  CONSTRAINT video_parts_uploaded_ref CHECK (state = 'pending' OR (telegram_message_id IS NOT NULL AND uploaded_at IS NOT NULL)),
  CONSTRAINT video_parts_verified_time CHECK (state <> 'verified' OR verified_at IS NOT NULL)
);
-- One Telegram message can never back two parts (no silent mixing of uploads).
CREATE UNIQUE INDEX video_parts_message ON video_parts (telegram_chat_id, telegram_message_id)
  WHERE telegram_message_id IS NOT NULL;

CREATE TABLE video_import_jobs (
  id uuid PRIMARY KEY,
  asset_id uuid NOT NULL REFERENCES video_assets(id) ON DELETE CASCADE,
  idempotency_key text NOT NULL UNIQUE CHECK (length(idempotency_key) BETWEEN 8 AND 200),
  stage text NOT NULL DEFAULT 'validate' CHECK (stage IN ('validate','prepare','upload','verify','publish')),
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','succeeded','failed','cancelled')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  max_attempts integer NOT NULL DEFAULT 5 CHECK (max_attempts BETWEEN 1 AND 100),
  next_run_at timestamptz NOT NULL DEFAULT now(),
  lease_owner text CHECK (lease_owner IS NULL OR length(lease_owner) BETWEEN 1 AND 100),
  lease_expires_at timestamptz,
  heartbeat_at timestamptz,
  progress jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(progress) = 'object'),
  artifacts jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(artifacts) = 'object'),
  error_category text CHECK (error_category IS NULL OR error_category ~ '^[A-Z0-9_]{1,64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT video_import_jobs_lease CHECK ((lease_owner IS NULL) = (lease_expires_at IS NULL)),
  CONSTRAINT video_import_jobs_running_lease CHECK (status <> 'running' OR lease_owner IS NOT NULL)
);
CREATE UNIQUE INDEX video_import_jobs_one_active ON video_import_jobs (asset_id) WHERE status IN ('queued','running');
CREATE INDEX video_import_jobs_due ON video_import_jobs (status, next_run_at);

-- Asset rules: allowed state transitions, immutable identity/layout, Ready gate.
CREATE FUNCTION video_assets_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  allowed text[];
  verified_count integer;
  verified_bytes bigint;
  last_end bigint;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.state <> 'pending' THEN
      RAISE EXCEPTION 'video asset must start pending' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  IF (NEW.imdb_id, NEW.content_type, NEW.season, NEW.episode, NEW.quality, NEW.edition, NEW.audio_languages)
     IS DISTINCT FROM
     (OLD.imdb_id, OLD.content_type, OLD.season, OLD.episode, OLD.quality, OLD.edition, OLD.audio_languages) THEN
    RAISE EXCEPTION 'video asset identity is immutable' USING ERRCODE = '23514';
  END IF;
  IF OLD.total_size IS NOT NULL AND
     (NEW.total_size, NEW.sha256, NEW.part_size, NEW.part_count) IS DISTINCT FROM
     (OLD.total_size, OLD.sha256, OLD.part_size, OLD.part_count) THEN
    RAISE EXCEPTION 'video asset layout is immutable once recorded' USING ERRCODE = '23514';
  END IF;

  IF NEW.state IS DISTINCT FROM OLD.state THEN
    allowed := CASE OLD.state
      WHEN 'pending'     THEN ARRAY['validating','failed']
      WHEN 'validating'  THEN ARRAY['preparing','failed']
      WHEN 'preparing'   THEN ARRAY['uploading','failed']
      WHEN 'uploading'   THEN ARRAY['verifying','failed']
      WHEN 'verifying'   THEN ARRAY['ready','uploading','failed']
      WHEN 'failed'      THEN ARRAY['pending','validating','preparing','uploading','verifying']
      WHEN 'ready'       THEN ARRAY['unavailable','superseded']
      WHEN 'unavailable' THEN ARRAY['verifying','superseded']
      ELSE ARRAY[]::text[]
    END;
    IF NOT (NEW.state = ANY(allowed)) THEN
      RAISE EXCEPTION 'invalid video asset transition % -> %', OLD.state, NEW.state USING ERRCODE = '23514';
    END IF;
    NEW.state_changed_at := now();
    IF NEW.state <> 'failed' THEN NEW.failure_reason := NULL; END IF;

    IF NEW.state = 'ready' THEN
      SELECT count(*), COALESCE(sum(size), 0), COALESCE(max(byte_offset + size), 0)
        INTO verified_count, verified_bytes, last_end
        FROM video_parts WHERE asset_id = NEW.id AND state = 'verified';
      IF verified_count <> NEW.part_count OR verified_bytes <> NEW.total_size OR last_end <> NEW.total_size
         OR EXISTS (SELECT 1 FROM video_parts WHERE asset_id = NEW.id AND state <> 'verified') THEN
        RAISE EXCEPTION 'video asset is not fully verified' USING ERRCODE = '23514';
      END IF;
      NEW.ready_at := now();
    END IF;
    IF NEW.state <> 'ready' THEN NEW.is_default := false; END IF;
  END IF;

  NEW.updated_at := now();
  RETURN NEW;
END $$;
CREATE TRIGGER video_assets_guard BEFORE INSERT OR UPDATE ON video_assets
  FOR EACH ROW EXECUTE FUNCTION video_assets_guard();

-- Part rules: exact offsets/sizes from the asset layout; immutable once stored.
CREATE FUNCTION video_parts_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  asset video_assets%ROWTYPE;
  expected_size bigint;
BEGIN
  SELECT * INTO asset FROM video_assets WHERE id = NEW.asset_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'video asset not found' USING ERRCODE = '23503';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF asset.total_size IS NULL THEN
      RAISE EXCEPTION 'record the prepared file before adding parts' USING ERRCODE = '23514';
    END IF;
    IF asset.state NOT IN ('preparing','uploading','failed') THEN
      RAISE EXCEPTION 'parts cannot be added to a % asset', asset.state USING ERRCODE = '23514';
    END IF;
    IF NEW.part_number > asset.part_count THEN
      RAISE EXCEPTION 'part number exceeds part count' USING ERRCODE = '23514';
    END IF;
    expected_size := LEAST(asset.part_size, asset.total_size - (NEW.part_number - 1) * asset.part_size);
    IF NEW.byte_offset <> (NEW.part_number - 1) * asset.part_size OR NEW.size <> expected_size THEN
      RAISE EXCEPTION 'part offset/size does not match the exact split layout' USING ERRCODE = '23514';
    END IF;
    IF NEW.state <> 'pending' THEN
      RAISE EXCEPTION 'parts must start pending' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  IF (NEW.asset_id, NEW.part_number, NEW.byte_offset, NEW.size, NEW.sha256)
     IS DISTINCT FROM (OLD.asset_id, OLD.part_number, OLD.byte_offset, OLD.size, OLD.sha256) THEN
    RAISE EXCEPTION 'part layout is immutable' USING ERRCODE = '23514';
  END IF;
  IF asset.state IN ('ready','unavailable','superseded') THEN
    -- Stored assets may only refresh references or record a confirmed loss/recovery.
    IF (NEW.telegram_chat_id, NEW.telegram_message_id) IS DISTINCT FROM (OLD.telegram_chat_id, OLD.telegram_message_id)
       OR NOT (NEW.state = OLD.state OR NEW.state = 'missing'
               OR (OLD.state = 'missing' AND NEW.state = 'verified' AND asset.state = 'unavailable')) THEN
      RAISE EXCEPTION 'parts of a stored asset are immutable' USING ERRCODE = '23514';
    END IF;
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END $$;
CREATE TRIGGER video_parts_guard BEFORE INSERT OR UPDATE ON video_parts
  FOR EACH ROW EXECUTE FUNCTION video_parts_guard();

-- Removing parts from a stored asset would break playback silently.
-- (Deleting the whole asset row cascades and is an explicit admin action.)
CREATE FUNCTION video_parts_delete_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM video_assets WHERE id = OLD.asset_id AND state IN ('ready','unavailable')) THEN
    RAISE EXCEPTION 'parts of a stored asset cannot be deleted' USING ERRCODE = '23514';
  END IF;
  RETURN OLD;
END $$;
CREATE TRIGGER video_parts_delete_guard BEFORE DELETE ON video_parts
  FOR EACH ROW EXECUTE FUNCTION video_parts_delete_guard();
