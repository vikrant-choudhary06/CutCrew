CREATE TABLE profiles (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 40),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX profiles_owner ON profiles(user_id);
CREATE TABLE sessions (
  token_hash text PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  csrf text NOT NULL,
  expires_at timestamptz NOT NULL
);
CREATE INDEX sessions_expiry ON sessions(expires_at);
CREATE TABLE watchlist (
  profile_id text NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  imdb_id text NOT NULL CHECK (imdb_id ~ '^tt[0-9]{5,12}$'),
  data jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(profile_id, imdb_id)
);
CREATE TABLE progress (
  profile_id text NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  imdb_id text NOT NULL CHECK (imdb_id ~ '^tt[0-9]{5,12}$'),
  season integer NOT NULL DEFAULT 0 CHECK(season >= 0),
  episode integer NOT NULL DEFAULT 0 CHECK(episode >= 0),
  position double precision NOT NULL CHECK(position >= 0),
  duration double precision,
  completed boolean NOT NULL DEFAULT false,
  data jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(profile_id, imdb_id, season, episode)
);
CREATE INDEX progress_recent ON progress(profile_id, updated_at DESC);
