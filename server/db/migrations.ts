import type { DatabaseSync } from 'node:sqlite';

// Numbered migrations; the version is PRAGMA user_version (spec §3). Never
// edit a shipped migration: add the next one.
export const MIGRATIONS: ((db: DatabaseSync) => void)[] = [
  // 1: the phase 1 schema (spec §4.1).
  (db) => db.exec(`
CREATE TABLE accounts (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  notes TEXT,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, version INTEGER NOT NULL DEFAULT 1
) STRICT;

CREATE TABLE account_users (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  display_name TEXT,
  role TEXT NOT NULL CHECK (role IN ('admin','viewer')),
  disabled INTEGER NOT NULL DEFAULT 0 CHECK (disabled IN (0,1)),
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, version INTEGER NOT NULL DEFAULT 1,
  UNIQUE (account_id, email)
) STRICT;
CREATE INDEX account_users_email ON account_users(email);

CREATE TABLE proxies (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  display_name TEXT NOT NULL,
  runs_on TEXT NOT NULL CHECK (runs_on IN ('cluster','local-host','cloud')),
  host_kind TEXT CHECK (host_kind IN ('pi','mini-pc','pc','mac','vm','container','other')),
  url TEXT, admin_ui_url TEXT, dns_name TEXT, tls_site TEXT, tls_servername TEXT,
  ca_fingerprints TEXT NOT NULL DEFAULT '[]',
  notes TEXT,
  state TEXT NOT NULL CHECK (state IN ('pending','enrolled','revoked')),
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, version INTEGER NOT NULL DEFAULT 1,
  UNIQUE (account_id, id),
  UNIQUE (account_id, name)
) STRICT;

CREATE TABLE proxy_keys (
  id TEXT PRIMARY KEY,
  proxy_id TEXT NOT NULL REFERENCES proxies(id) ON DELETE CASCADE,
  public_key TEXT NOT NULL UNIQUE,
  fingerprint TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  enrollment_id TEXT,
  last_seen_at INTEGER,
  revoked_at INTEGER,
  revoked_reason TEXT CHECK (revoked_reason IN ('admin','re-enrolled','proxy-deleted','unenrolled','blocked'))
) STRICT;
CREATE UNIQUE INDEX proxy_keys_one_active ON proxy_keys(proxy_id) WHERE revoked_at IS NULL;

CREATE TABLE enrollment_codes (
  id TEXT PRIMARY KEY,
  proxy_id TEXT NOT NULL REFERENCES proxies(id) ON DELETE CASCADE,
  code_hash TEXT NOT NULL UNIQUE,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
  used_at INTEGER, cancelled_at INTEGER
) STRICT;
CREATE UNIQUE INDEX enrollment_codes_one_live ON enrollment_codes(proxy_id) WHERE used_at IS NULL AND cancelled_at IS NULL;

CREATE TABLE cameras (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  proxy_id TEXT,
  cams_id TEXT NOT NULL,
  proxy_camera_id TEXT,
  name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('camera','sim')),
  model TEXT, host TEXT,
  protocol TEXT CHECK (protocol IN ('https','http')),
  tls_servername TEXT, camera_user TEXT, web_ui_url TEXT, web_ui_note TEXT, notes TEXT,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, version INTEGER NOT NULL DEFAULT 1,
  UNIQUE (account_id, cams_id),
  UNIQUE (proxy_id, proxy_camera_id),
  CHECK (proxy_id IS NULL OR proxy_camera_id IS NOT NULL),
  -- A camera can only belong to a proxy of its own account (enforced here,
  -- not just in the API). SQLite has no SET NULL (column), so the trigger
  -- below clears proxy_id before a proxy row goes.
  FOREIGN KEY (account_id, proxy_id) REFERENCES proxies(account_id, id)
) STRICT;
CREATE INDEX cameras_proxy ON cameras(proxy_id);
CREATE TRIGGER proxies_release_cameras BEFORE DELETE ON proxies
BEGIN
  UPDATE cameras SET proxy_id = NULL WHERE proxy_id = OLD.id;
END;

CREATE TABLE sims (
  camera_id TEXT PRIMARY KEY REFERENCES cameras(id) ON DELETE CASCADE,
  runs_on TEXT NOT NULL CHECK (runs_on IN ('mac','cluster','pi','pc','cloud','other')),
  control_url TEXT, ui_url TEXT, image TEXT, notes TEXT
) STRICT;
CREATE TRIGGER sims_only_for_sims_ins BEFORE INSERT ON sims
WHEN (SELECT kind FROM cameras WHERE id = NEW.camera_id) IS NOT 'sim'
BEGIN SELECT RAISE(ABORT, 'camera is not a sim'); END;
CREATE TRIGGER sims_only_for_sims_kind BEFORE UPDATE OF kind ON cameras
WHEN NEW.kind <> 'sim' AND EXISTS (SELECT 1 FROM sims WHERE camera_id = NEW.id)
BEGIN SELECT RAISE(ABORT, 'camera is not a sim'); END;

CREATE TABLE proxy_status (
  proxy_id TEXT PRIMARY KEY REFERENCES proxies(id) ON DELETE CASCADE,
  connected INTEGER NOT NULL DEFAULT 0,
  connected_since INTEGER, last_hello_at INTEGER, last_heartbeat_at INTEGER,
  closed_reason TEXT,
  stopped INTEGER NOT NULL DEFAULT 0,
  proxy_version TEXT,
  clock_skew_ms INTEGER,
  summary TEXT,
  summary_at INTEGER,
  ok INTEGER, problem_count INTEGER,
  reported TEXT,
  online INTEGER NOT NULL DEFAULT 0
) STRICT;

CREATE TABLE status_events (
  id INTEGER PRIMARY KEY,
  proxy_id TEXT NOT NULL REFERENCES proxies(id) ON DELETE CASCADE,
  camera_ref TEXT,
  at INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('connected','disconnected','online','offline','stopped','problems-changed','camera-online','camera-offline','version-changed','pin-mismatch','pin-match')),
  detail TEXT
) STRICT;
CREATE INDEX status_events_proxy_at ON status_events(proxy_id, at);

CREATE TABLE audit_log (
  id TEXT PRIMARY KEY,
  at INTEGER NOT NULL,
  actor_type TEXT NOT NULL CHECK (actor_type IN ('sysadmin','proxy','system')),
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  account_id TEXT,
  target_type TEXT, target_id TEXT, target_label TEXT,
  outcome TEXT NOT NULL CHECK (outcome IN ('ok','refused','failed')),
  detail TEXT
) STRICT;
CREATE INDEX audit_at ON audit_log(at);
CREATE INDEX audit_account_at ON audit_log(account_id, at);
CREATE INDEX audit_action_at ON audit_log(action, at);

CREATE TABLE sessions (
  id_hash TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL
) STRICT;

CREATE TABLE jobs (
  name TEXT PRIMARY KEY,
  last_run_at INTEGER, last_ok_at INTEGER, last_outcome TEXT, last_detail TEXT
) STRICT;

CREATE TABLE meta (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  write_epoch INTEGER NOT NULL
) STRICT;
INSERT INTO meta (id, write_epoch) VALUES (1, 0);
`),
];
