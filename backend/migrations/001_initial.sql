-- Catalogue aggregates retain provider-specific structures in JSONB.
-- Indexed generated columns support SQL filtering and sorting.
CREATE TABLE movies (
  imdb_id text PRIMARY KEY CHECK (imdb_id ~ '^tt[0-9]{5,12}$'),
  data jsonb NOT NULL CHECK (jsonb_typeof(data) = 'object' AND COALESCE(jsonb_typeof(data->'title') = 'string' AND length(data->>'title') > 0, false)),
  title text GENERATED ALWAYS AS (data->>'title') STORED,
  title_type text GENERATED ALWAYS AS (data->>'title_type') STORED,
  release_year integer GENERATED ALWAYS AS ((data->>'release_year')::integer) STORED,
  release_date text GENERATED ALWAYS AS (data->>'release_date') STORED,
  vote_count bigint GENERATED ALWAYS AS ((data->>'vote_count')::bigint) STORED,
  rating numeric GENERATED ALWAYS AS ((data->>'rating')::numeric) STORED,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX movies_trending ON movies(title_type, vote_count DESC, rating DESC);
CREATE INDEX movies_release ON movies(release_date DESC);
CREATE INDEX movies_year ON movies(release_year);
CREATE INDEX movies_genres ON movies USING gin ((data->'genres'));
CREATE INDEX movies_country ON movies USING gin ((data->'country'));
CREATE TABLE users (
  id text PRIMARY KEY,
  email text NOT NULL UNIQUE,
  password text NOT NULL,
  role text NOT NULL DEFAULT 'user' CHECK (role IN ('user', 'admin')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
