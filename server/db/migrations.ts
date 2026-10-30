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
  // 8: camera moves (plan 2026-10-21, Task 2): the move job and its chunk
  // states. Same account for source and target is enforced by the composite
  // FKs; one non-ended move per source, per target and per camera by partial
  // unique indexes. token_hash holds only 'sha256:<hex>' (never a token).
  // offered_at / approved_at: the 30-minute offer expiry and the budget clock.
  // cameras.move_id is set at the switch-over, never cleared (the next move overwrites).
  // cleanup_pending: a move done while the source's cleanup has not landed (it ended early with the source away or not released).
  // target_cleanup_pending: the same for the target's finish (it ended early with the target away: its finish went unanswered).
  (db) => db.exec(`
CREATE TABLE moves (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  camera_id TEXT NOT NULL REFERENCES cameras(id) ON DELETE CASCADE,
  source_proxy_id TEXT NOT NULL,
  target_proxy_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  phase TEXT NOT NULL CHECK (phase IN ('requested','offered','awaiting-approval','approved','switching','copying','cleaning','done','rejected','cancelling','cancelled','failed')),
  reason TEXT, plan TEXT, summary TEXT, settings TEXT,
  token_hash TEXT CHECK (token_hash IS NULL OR token_hash GLOB 'sha256:*'),
  target_ip TEXT, target_public_key TEXT, leaf_fingerprint TEXT, copied_choice TEXT,
  offered_at INTEGER, approved_at INTEGER, budget_exceeded_at INTEGER,
  bytes_total INTEGER, bytes_done INTEGER, rate_bps INTEGER, eta_s INTEGER,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, ended_at INTEGER,
  actor TEXT, version INTEGER NOT NULL DEFAULT 1,
  cleanup_pending INTEGER NOT NULL DEFAULT 0 CHECK (cleanup_pending IN (0, 1)),
  target_cleanup_pending INTEGER NOT NULL DEFAULT 0 CHECK (target_cleanup_pending IN (0, 1)),
  CHECK (source_proxy_id <> target_proxy_id),
  FOREIGN KEY (account_id, source_proxy_id) REFERENCES proxies(account_id, id) ON DELETE CASCADE,
  FOREIGN KEY (account_id, target_proxy_id) REFERENCES proxies(account_id, id) ON DELETE CASCADE
) STRICT;
-- One active move per proxy in either role (the partial indexes below only
-- cover the same role).
CREATE TRIGGER moves_proxy_busy BEFORE INSERT ON moves
WHEN EXISTS (SELECT 1 FROM moves WHERE ended_at IS NULL AND (source_proxy_id IN (NEW.source_proxy_id, NEW.target_proxy_id) OR target_proxy_id IN (NEW.source_proxy_id, NEW.target_proxy_id)))
BEGIN SELECT RAISE(ABORT, 'moves: proxy busy'); END;
CREATE UNIQUE INDEX moves_one_per_source ON moves(source_proxy_id) WHERE ended_at IS NULL;
CREATE UNIQUE INDEX moves_one_per_target ON moves(target_proxy_id) WHERE ended_at IS NULL;
CREATE UNIQUE INDEX moves_one_per_camera ON moves(camera_id) WHERE ended_at IS NULL;
CREATE INDEX moves_account_created ON moves(account_id, created_at);
-- Done moves whose source cleanup (move.release, move.finish) still has to land (Task 6 ruling b).
CREATE INDEX moves_cleanup_pending ON moves(source_proxy_id) WHERE cleanup_pending = 1;
-- Done moves whose target finish still has to land (an ended-early move whose target was away).
CREATE INDEX moves_target_cleanup_pending ON moves(target_proxy_id) WHERE target_cleanup_pending = 1;
CREATE TABLE move_chunks (
  move_id TEXT NOT NULL REFERENCES moves(id) ON DELETE CASCADE,
  chunk_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending','copied','verified','skipped','failed','abandoned')),
  PRIMARY KEY (move_id, chunk_id)
) STRICT;
ALTER TABLE cameras ADD COLUMN move_id TEXT;
`),
  // 9: read-only diagnostics tokens (issue #45): only the SHA-256 hash is
  // stored; reads never write here (last use is kept in memory).
  (db) => db.exec(`
CREATE TABLE diag_tokens (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 64),
  hash TEXT NOT NULL UNIQUE CHECK (hash GLOB 'sha256:*' AND length(hash) = 71),
  created_at INTEGER NOT NULL, created_by TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER, revoked_by TEXT
) STRICT;
`),
  // 10: operations tokens: write-scoped bearer tokens for scripts. Same shape
  // as diag_tokens, plus the scopes (a JSON array).
  (db) => db.exec(`
CREATE TABLE ops_tokens (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 64),
  hash TEXT NOT NULL UNIQUE CHECK (hash GLOB 'sha256:*' AND length(hash) = 71),
  created_at INTEGER NOT NULL, created_by TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER, revoked_by TEXT,
  scopes TEXT NOT NULL
) STRICT;
`),
  // 11: the pre-approval bounds a move.request carried (JSON, or NULL when the
  // source sent none): the move view shows them; the source does the approving.
  (db) => db.exec(`ALTER TABLE moves ADD COLUMN bounds TEXT;`),
  // 12: a cams instance's last status report (JSON) and when it last changed,
  // so a restart does not lose it (issue #58). Written only on a changed report.
  (db) => db.exec(`ALTER TABLE cams_instances ADD COLUMN last_report TEXT; ALTER TABLE cams_instances ADD COLUMN last_report_at INTEGER;`),
  // 13: when the move switched the camera over (ms): the cams attestation expires
  // 24 h after it. NULL for moves from before this migration (no attestation).
  (db) => db.exec(`ALTER TABLE moves ADD COLUMN switched_at INTEGER;`),
  // 14: camera move step 4 (spec 2026-10-23): a copy back after a cancel is its
  // own move row (return_of names the cancelled move; phases 'returning' ->
  // 'returned'), the completeness check (check_result, JSON), the days an ended
  // move is kept (keep_days, reported by the proxy) and an End transfer waiting
  // for Archive (end_requested, JSON {at, actorType, actor}). The phase CHECK
  // needs a table rebuild. migrate() runs with foreign_keys ON (it can't be
  // switched inside the transaction), so DROP TABLE moves would cascade into
  // move_chunks: the chunk states are set aside first and copied back. Indexes
  // and the trigger are migration 8's, verbatim (test/db.test.ts compares them).
  (db) => db.exec(`
CREATE TABLE move_chunks_m14 AS SELECT * FROM move_chunks;
DROP TABLE move_chunks;
CREATE TABLE moves_m14 (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  camera_id TEXT NOT NULL REFERENCES cameras(id) ON DELETE CASCADE,
  source_proxy_id TEXT NOT NULL,
  target_proxy_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  phase TEXT NOT NULL CHECK (phase IN ('requested','offered','awaiting-approval','approved','switching','copying','cleaning','done','rejected','cancelling','cancelled','failed','returning','returned')),
  reason TEXT, plan TEXT, summary TEXT, settings TEXT,
  token_hash TEXT CHECK (token_hash IS NULL OR token_hash GLOB 'sha256:*'),
  target_ip TEXT, target_public_key TEXT, leaf_fingerprint TEXT, copied_choice TEXT,
  offered_at INTEGER, approved_at INTEGER, budget_exceeded_at INTEGER,
  bytes_total INTEGER, bytes_done INTEGER, rate_bps INTEGER, eta_s INTEGER,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, ended_at INTEGER,
  actor TEXT, version INTEGER NOT NULL DEFAULT 1,
  cleanup_pending INTEGER NOT NULL DEFAULT 0 CHECK (cleanup_pending IN (0, 1)),
  target_cleanup_pending INTEGER NOT NULL DEFAULT 0 CHECK (target_cleanup_pending IN (0, 1)),
  bounds TEXT,
  switched_at INTEGER,
  return_of TEXT,
  check_result TEXT,
  keep_days INTEGER CHECK (keep_days IS NULL OR keep_days BETWEEN 7 AND 3650),
  end_requested TEXT,
  CHECK (source_proxy_id <> target_proxy_id),
  FOREIGN KEY (account_id, source_proxy_id) REFERENCES proxies(account_id, id) ON DELETE CASCADE,
  FOREIGN KEY (account_id, target_proxy_id) REFERENCES proxies(account_id, id) ON DELETE CASCADE
) STRICT;
INSERT INTO moves_m14 (id, account_id, camera_id, source_proxy_id, target_proxy_id, request_id, phase, reason, plan, summary, settings, token_hash,
  target_ip, target_public_key, leaf_fingerprint, copied_choice, offered_at, approved_at, budget_exceeded_at, bytes_total, bytes_done, rate_bps, eta_s,
  created_at, updated_at, ended_at, actor, version, cleanup_pending, target_cleanup_pending, bounds, switched_at)
  SELECT id, account_id, camera_id, source_proxy_id, target_proxy_id, request_id, phase, reason, plan, summary, settings, token_hash,
  target_ip, target_public_key, leaf_fingerprint, copied_choice, offered_at, approved_at, budget_exceeded_at, bytes_total, bytes_done, rate_bps, eta_s,
  created_at, updated_at, ended_at, actor, version, cleanup_pending, target_cleanup_pending, bounds, switched_at FROM moves;
DROP TABLE moves;
ALTER TABLE moves_m14 RENAME TO moves;
CREATE TRIGGER moves_proxy_busy BEFORE INSERT ON moves
WHEN EXISTS (SELECT 1 FROM moves WHERE ended_at IS NULL AND (source_proxy_id IN (NEW.source_proxy_id, NEW.target_proxy_id) OR target_proxy_id IN (NEW.source_proxy_id, NEW.target_proxy_id)))
BEGIN SELECT RAISE(ABORT, 'moves: proxy busy'); END;
CREATE UNIQUE INDEX moves_one_per_source ON moves(source_proxy_id) WHERE ended_at IS NULL;
CREATE UNIQUE INDEX moves_one_per_target ON moves(target_proxy_id) WHERE ended_at IS NULL;
CREATE UNIQUE INDEX moves_one_per_camera ON moves(camera_id) WHERE ended_at IS NULL;
CREATE INDEX moves_account_created ON moves(account_id, created_at);
CREATE INDEX moves_cleanup_pending ON moves(source_proxy_id) WHERE cleanup_pending = 1;
CREATE INDEX moves_target_cleanup_pending ON moves(target_proxy_id) WHERE target_cleanup_pending = 1;
-- The return of a cancelled move (MoveStore.returnFor; prune keeps a move a return names).
CREATE INDEX moves_return_of ON moves(return_of);
CREATE TABLE move_chunks (
  move_id TEXT NOT NULL REFERENCES moves(id) ON DELETE CASCADE,
  chunk_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending','copied','verified','skipped','failed','abandoned')),
  PRIMARY KEY (move_id, chunk_id)
) STRICT;
INSERT INTO move_chunks (move_id, chunk_id, state) SELECT move_id, chunk_id, state FROM move_chunks_m14;
DROP TABLE move_chunks_m14;
`),
  // 15: a refusal's detail (the target's own words, or cams-admin's: which
  // check refused and with what values); NULL when there is none. cams-admin's
  // own refusals get a rejected row too, written ended: the busy trigger now
  // guards rows that are not ended only (the partial unique indexes already did).
  (db) => db.exec(`
ALTER TABLE moves ADD COLUMN detail TEXT CHECK (detail IS NULL OR length(detail) BETWEEN 1 AND 300);
DROP TRIGGER moves_proxy_busy;
CREATE TRIGGER moves_proxy_busy BEFORE INSERT ON moves
WHEN NEW.ended_at IS NULL AND EXISTS (SELECT 1 FROM moves WHERE ended_at IS NULL AND (source_proxy_id IN (NEW.source_proxy_id, NEW.target_proxy_id) OR target_proxy_id IN (NEW.source_proxy_id, NEW.target_proxy_id)))
BEGIN SELECT RAISE(ABORT, 'moves: proxy busy'); END;
`),
  // 16: the space a move needs against the target's reported profile, as it was
  // when the source's request arrived (proxy profile design §3, "space"; JSON:
  // need, budget, used, left, fits, the kinds over their cap). NULL when the
  // target reported no profile then, and for every move from before.
  (db) => db.exec(`ALTER TABLE moves ADD COLUMN space TEXT;`),
  // 17: a camera's onboarding ready flip (heartbeat onboarding; cam-proxy onboarding
  // design §4.5) is a status event: the kind CHECK gains onboarding-ready and
  // onboarding-not-ready, which needs a table rebuild. Nothing references
  // status_events, so the rows are copied over with their ids.
  (db) => db.exec(`
CREATE TABLE status_events_m17 (
  id INTEGER PRIMARY KEY,
  proxy_id TEXT NOT NULL REFERENCES proxies(id) ON DELETE CASCADE,
  camera_ref TEXT,
  at INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('connected','disconnected','online','offline','stopped','problems-changed','camera-online','camera-offline','version-changed','pin-mismatch','pin-match','onboarding-ready','onboarding-not-ready')),
  detail TEXT
) STRICT;
INSERT INTO status_events_m17 (id, proxy_id, camera_ref, at, kind, detail) SELECT id, proxy_id, camera_ref, at, kind, detail FROM status_events;
DROP TABLE status_events;
ALTER TABLE status_events_m17 RENAME TO status_events;
CREATE INDEX status_events_proxy_at ON status_events(proxy_id, at);
`),
  // 18: auto-adopt per account (cam-proxy onboarding design §5; off by default) and
  // the cameras it must never bring back: one row per (proxy, proxy camera id) that
  // was deleted from the registry or moved off that proxy; a manual adopt lifts it.
  (db) => db.exec(`
ALTER TABLE accounts ADD COLUMN auto_adopt INTEGER NOT NULL DEFAULT 0 CHECK (auto_adopt IN (0, 1));
CREATE TABLE adopt_blocks (
  proxy_id TEXT NOT NULL REFERENCES proxies(id) ON DELETE CASCADE,
  proxy_camera_id TEXT NOT NULL,
  reason TEXT NOT NULL CHECK (reason IN ('deleted', 'moved')),
  blocked_at INTEGER NOT NULL,
  PRIMARY KEY (proxy_id, proxy_camera_id)
) STRICT;
`),
];
