-- APK and installer downloads, counted when the download link is opened
-- (website, landing page and the app's own update). Shown in the admin panel.
CREATE TABLE app_downloads (
  id bigserial PRIMARY KEY,
  platform text NOT NULL CHECK (platform IN ('android', 'windows')),
  version text CHECK (version IS NULL OR version ~ '^[0-9]+\.[0-9]+\.[0-9]+$'),
  source text NOT NULL DEFAULT 'web' CHECK (source IN ('web', 'app', 'landing')),
  ip text NOT NULL CHECK (length(ip) BETWEEN 1 AND 64),
  country text CHECK (country IS NULL OR country ~ '^[A-Z]{2}$'),
  user_agent text CHECK (user_agent IS NULL OR length(user_agent) <= 300),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX app_downloads_time ON app_downloads (created_at DESC);
