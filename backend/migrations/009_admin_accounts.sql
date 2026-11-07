-- Admin panel sign-in: people with an email and password. The owner can add
-- and remove admins. Passwords are stored only as scrypt hashes; sessions only
-- as SHA-256 hashes of the cookie value.
CREATE TABLE admin_users (
  id uuid PRIMARY KEY,
  email text NOT NULL UNIQUE CHECK (email = lower(email) AND email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' AND length(email) <= 200),
  password_hash text NOT NULL CHECK (password_hash ~ '^scrypt:[0-9a-f]{32}:[0-9a-f]{128}$'),
  role text NOT NULL DEFAULT 'admin' CHECK (role IN ('owner', 'admin')),
  created_by uuid REFERENCES admin_users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_login_at timestamptz
);
CREATE TABLE admin_sessions (
  token_hash text PRIMARY KEY CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  admin_id uuid NOT NULL REFERENCES admin_users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  ip text CHECK (ip IS NULL OR length(ip) <= 64)
);
CREATE INDEX admin_sessions_admin ON admin_sessions (admin_id);
