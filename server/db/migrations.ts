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
  // 2: a key is pending until its first hello (confirmed_at). Pending keys
  // don't replace the active one; a lost enroll answer leaves no active key.
  // Existing keys: confirmed if they were ever seen, else pending.
  (db) => db.exec(`
ALTER TABLE proxy_keys ADD COLUMN confirmed_at INTEGER;
UPDATE proxy_keys SET confirmed_at = last_seen_at WHERE last_seen_at IS NOT NULL;
DROP INDEX proxy_keys_one_active;
CREATE UNIQUE INDEX proxy_keys_one_active ON proxy_keys(proxy_id) WHERE revoked_at IS NULL AND confirmed_at IS NOT NULL;
CREATE UNIQUE INDEX proxy_keys_one_pending ON proxy_keys(proxy_id) WHERE revoked_at IS NULL AND confirmed_at IS NULL;
`),
  // 3: migration 2 keyed on last_seen_at, but the status snapshot stamped the
  // proxy's last hello onto every unrevoked key of the proxy, also onto a key
  // redeemed after that hello and never used. Such a stamp predates the key
  // (last_seen_at < created_at): that key was never seen and is pending again.
  // If the proxy has a newer pending key, the stale one is retired instead.
  (db) => db.exec(`
UPDATE proxy_keys SET revoked_at = unixepoch() * 1000, revoked_reason = 're-enrolled'
  WHERE revoked_at IS NULL AND confirmed_at IS NOT NULL AND last_seen_at < created_at
  AND EXISTS (SELECT 1 FROM proxy_keys p WHERE p.proxy_id = proxy_keys.proxy_id AND p.revoked_at IS NULL AND p.confirmed_at IS NULL);
UPDATE proxy_keys SET confirmed_at = NULL, last_seen_at = NULL
  WHERE confirmed_at IS NOT NULL AND last_seen_at < created_at;
`),
  // 4: phase 2, commands and managed tokens (migration spec §5). Never a
  // token, only its hash. issued_revision: the revision whose set first
  // carried the token (a heartbeat's tokens.revision confirms it).
  (db) => db.exec(`
CREATE TABLE commands (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  proxy_id TEXT REFERENCES proxies(id) ON DELETE SET NULL,
  actor TEXT NOT NULL,
  command TEXT NOT NULL,
  args TEXT NOT NULL CHECK (length(args) <= 16384),
  dry_run INTEGER NOT NULL DEFAULT 0 CHECK (dry_run IN (0,1)),
  revocation_only INTEGER NOT NULL DEFAULT 0 CHECK (revocation_only IN (0,1)),
  state TEXT NOT NULL CHECK (state IN ('queued','sent','received','done','refused','failed','expired','unknown')),
  outcome_code TEXT,
  result TEXT CHECK (result IS NULL OR length(result) <= 98304),
  result_sig TEXT,
  created_at INTEGER NOT NULL, sent_at INTEGER, finished_at INTEGER,
  attempts INTEGER NOT NULL DEFAULT 0
) STRICT;
CREATE INDEX commands_proxy_created ON commands(proxy_id, created_at);
CREATE INDEX commands_open ON commands(state, created_at) WHERE state IN ('queued','sent','received');

CREATE TABLE proxy_tokens (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  proxy_id TEXT NOT NULL REFERENCES proxies(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('client','admin')),
  holder TEXT NOT NULL,
  label TEXT NOT NULL CHECK (length(label) BETWEEN 1 AND 64),
  hash TEXT NOT NULL UNIQUE CHECK (hash GLOB 'sha256:*' AND length(hash) = 71),
  state TEXT NOT NULL CHECK (state IN ('pending','active','retiring','revoked','external')),
  issued_revision INTEGER NOT NULL,
  applied_revision INTEGER,
  retire_at INTEGER, revoked_at INTEGER, revoked_revision INTEGER,
  created_at INTEGER NOT NULL, created_by TEXT NOT NULL,
  FOREIGN KEY (account_id, proxy_id) REFERENCES proxies(account_id, id)
) STRICT;
CREATE INDEX proxy_tokens_proxy ON proxy_tokens(proxy_id, state);

CREATE TABLE proxy_token_state (
  proxy_id TEXT PRIMARY KEY REFERENCES proxies(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL DEFAULT 0,
  applied_revision INTEGER NOT NULL DEFAULT 0
) STRICT;
`),
  // 5: P4 (migration spec §5, plan rulings R4-1…R4-4): cams instances, their
  // keys, codes, served accounts and routes; one config_revision per account,
  // bumped by triggers inside the writer's transaction (so no registry path
  // can forget it); audit actor type 'cams' (the table is rebuilt for its CHECK).
  (db) => db.exec(`
CREATE TABLE cams_instances (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE CHECK (length(name) BETWEEN 1 AND 32),
  display_name TEXT NOT NULL,
  base_url TEXT, notes TEXT,
  state TEXT NOT NULL CHECK (state IN ('pending','enrolled','revoked')),
  rotate_before INTEGER,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, version INTEGER NOT NULL DEFAULT 1
) STRICT;
CREATE TABLE cams_instance_keys (
  id TEXT PRIMARY KEY,
  instance_id TEXT NOT NULL REFERENCES cams_instances(id) ON DELETE CASCADE,
  public_key TEXT NOT NULL UNIQUE, fingerprint TEXT NOT NULL,
  created_at INTEGER NOT NULL, enrollment_id TEXT, confirmed_at INTEGER, last_seen_at INTEGER,
  revoked_at INTEGER, revoked_reason TEXT CHECK (revoked_reason IN ('admin','re-enrolled','instance-deleted','blocked'))
) STRICT;
CREATE UNIQUE INDEX cams_keys_one_active ON cams_instance_keys(instance_id) WHERE revoked_at IS NULL AND confirmed_at IS NOT NULL;
CREATE UNIQUE INDEX cams_keys_one_pending ON cams_instance_keys(instance_id) WHERE revoked_at IS NULL AND confirmed_at IS NULL;
CREATE TABLE cams_enrollment_codes (
  id TEXT PRIMARY KEY,
  instance_id TEXT NOT NULL REFERENCES cams_instances(id) ON DELETE CASCADE,
  code_hash TEXT NOT NULL UNIQUE, created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, used_at INTEGER, cancelled_at INTEGER
) STRICT;
CREATE UNIQUE INDEX cams_codes_one_live ON cams_enrollment_codes(instance_id) WHERE used_at IS NULL AND cancelled_at IS NULL;
CREATE TABLE cams_instance_accounts (
  instance_id TEXT NOT NULL REFERENCES cams_instances(id) ON DELETE CASCADE,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  PRIMARY KEY (instance_id, account_id)
) STRICT;
CREATE TABLE cams_instance_routes (
  instance_id TEXT NOT NULL REFERENCES cams_instances(id) ON DELETE CASCADE,
  proxy_id TEXT NOT NULL REFERENCES proxies(id) ON DELETE CASCADE,
  url TEXT, hidden INTEGER NOT NULL DEFAULT 0 CHECK (hidden IN (0,1)),
  PRIMARY KEY (instance_id, proxy_id)
) STRICT;
CREATE INDEX cams_routes_proxy ON cams_instance_routes(proxy_id);
CREATE TABLE config_revision (
  account_id TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL DEFAULT 1
) STRICT;
INSERT INTO config_revision (account_id) SELECT id FROM accounts;
CREATE TRIGGER rev_account_ins AFTER INSERT ON accounts BEGIN INSERT INTO config_revision (account_id) VALUES (NEW.id); END;
CREATE TRIGGER rev_account_upd AFTER UPDATE ON accounts BEGIN UPDATE config_revision SET revision = revision + 1 WHERE account_id = NEW.id; END;
${['account_users', 'proxies', 'cameras', 'proxy_tokens'].map((t) => `
CREATE TRIGGER rev_${t}_ins AFTER INSERT ON ${t} BEGIN UPDATE config_revision SET revision = revision + 1 WHERE account_id = NEW.account_id; END;
CREATE TRIGGER rev_${t}_upd AFTER UPDATE ON ${t} BEGIN UPDATE config_revision SET revision = revision + 1 WHERE account_id IN (NEW.account_id, OLD.account_id); END;
CREATE TRIGGER rev_${t}_del AFTER DELETE ON ${t} BEGIN UPDATE config_revision SET revision = revision + 1 WHERE account_id = OLD.account_id; END;`).join('')}
${['INSERT', 'UPDATE', 'DELETE'].map((op) => `
CREATE TRIGGER rev_routes_${op.toLowerCase()} AFTER ${op} ON cams_instance_routes BEGIN
  UPDATE config_revision SET revision = revision + 1 WHERE account_id IN (SELECT account_id FROM proxies WHERE id IN (${op === 'DELETE' ? 'OLD.proxy_id' : op === 'INSERT' ? 'NEW.proxy_id' : 'NEW.proxy_id, OLD.proxy_id'}));
END;`).join('')}

CREATE TABLE audit_log_p4 (
  id TEXT PRIMARY KEY,
  at INTEGER NOT NULL,
  actor_type TEXT NOT NULL CHECK (actor_type IN ('sysadmin','proxy','system','cams')),
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  account_id TEXT,
  target_type TEXT, target_id TEXT, target_label TEXT,
  outcome TEXT NOT NULL CHECK (outcome IN ('ok','refused','failed')),
  detail TEXT
) STRICT;
INSERT INTO audit_log_p4 (id, at, actor_type, actor, action, account_id, target_type, target_id, target_label, outcome, detail)
  SELECT id, at, actor_type, actor, action, account_id, target_type, target_id, target_label, outcome, detail FROM audit_log;
DROP TABLE audit_log;
ALTER TABLE audit_log_p4 RENAME TO audit_log;
CREATE INDEX audit_at ON audit_log(at);
CREATE INDEX audit_account_at ON audit_log(account_id, at);
CREATE INDEX audit_action_at ON audit_log(action, at);
`),
  // 6: phase 3, the last reported configuration per proxy (migration spec §5,
  // §8.1). R3-15: a real write names the dry run it was made from (preview_of);
  // the unique index makes each dry run usable once, across restarts and races.
  (db) => db.exec(`
CREATE TABLE proxy_config (
  proxy_id TEXT PRIMARY KEY REFERENCES proxies(id) ON DELETE CASCADE,
  revision TEXT NOT NULL CHECK (revision GLOB 'sha256:*' AND length(revision) = 71),
  view TEXT NOT NULL CHECK (length(view) <= 262144),
  cmd_id TEXT NOT NULL,
  fetched_at INTEGER NOT NULL
) STRICT;
ALTER TABLE commands ADD COLUMN preview_of TEXT;
CREATE UNIQUE INDEX commands_preview_of ON commands(preview_of) WHERE preview_of IS NOT NULL;
`),
  // 7: per-instance camera overrides (cut-over step 6): a cams instance may
  // reach a camera at its own host and with its own camera user (the cluster
  // at the camera's address, the Pi through its proxy). NULL = the camera's
  // shared value. Writers bump the instance's version (its snapshot revision).
  (db) => db.exec(`
CREATE TABLE cams_camera_overrides (
  instance_id TEXT NOT NULL REFERENCES cams_instances(id) ON DELETE CASCADE,
  camera_id TEXT NOT NULL REFERENCES cameras(id) ON DELETE CASCADE,
  host TEXT CHECK (host IS NULL OR length(host) BETWEEN 1 AND 253),
  camera_user TEXT CHECK (camera_user IS NULL OR length(camera_user) BETWEEN 1 AND 64),
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, version INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (instance_id, camera_id),
  CHECK (host IS NOT NULL OR camera_user IS NOT NULL)
) STRICT;
CREATE INDEX cams_overrides_camera ON cams_camera_overrides(camera_id);
`),
];
