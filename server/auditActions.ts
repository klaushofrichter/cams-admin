// The audit log's actions. No imports: the web bundle reads this list (Audit page filter).
// The closed list of spec §11.4, like cam-proxy's AUDIT_ACTIONS.
export const AUDIT_ACTIONS = [
  'signin', 'signin-refused', 'signout', 'sessions-ended',
  'account-create', 'account-update', 'account-delete', 'user-create', 'user-update', 'user-delete',
  'proxy-create', 'proxy-update', 'proxy-delete', 'proxy-block', 'camera-create', 'camera-update', 'camera-delete', 'camera-adopt', 'sim-update', 'sim-delete',
  'enrollment-code-create', 'enrollment-code-cancel', 'proxy-enrolled', 'key-confirmed', 'enroll-refused', 'key-revoke', 'proxy-auth-refused',
  'backup-snapshot', 'backup-now', 'restore-detected',
  'command-create', 'command-result', 'command-expired', 'token-issue', 'token-retire', 'token-revoke',
  'audit-throttled',
  // P4: cams instances, the service API, import and export.
  'cams-instance-create', 'cams-instance-update', 'cams-instance-delete', 'cams-instance-block', 'cams-enrollment-code-create', 'cams-enrollment-code-cancel',
  'cams-enrolled', 'cams-enroll-refused', 'cams-key-confirmed', 'cams-key-revoke', 'cams-auth-refused', 'route-update', 'cams-rotate',
  'import-run', 'import-apply', 'export-run', 'camera-override-set', 'camera-override-clear',
  // Camera move: a proxy's move event that was dropped (bad signature, wrong target, strict schema).
  'move-event-refused',
  // The move job (plan Task 4): a source's request (ok or refused), the offer to the target and its answer, a phase change.
  'move-request', 'move-offer', 'move-phase',
  // Plan Task 5: the source's approval (ok or refused) and the registry switch-over to the target.
  'move-approve', 'move-switch',
  // Plan Task 6: the end of the move: the time budget ran out (once), a cancel, the transfer ended early, the move done.
  'move-budget-exceeded', 'move-cancel', 'move-end-transfer', 'move-done',
  // Step 4: the completeness check, the copy back, giving up a return, ending after Archive, ended moves pruned.
  'move-check', 'move-return', 'move-give-up', 'move-end-after-archive', 'moves-pruned',
  // A rejected move removed by a sysadmin (a refusal is final; the row held no content).
  'move-delete',
  // A move started from cams-admin (move.begin plan Task 3): each precheck fix it made, and its move.begin (queued, or failed at the source).
  'move-fix', 'move-begin',
  // Read-only diagnostics tokens (issue #45): issued, revoked, and a bearer token refused (throttled).
  'diag-token-issue', 'diag-token-revoke', 'diag-auth-refused',
  // Operations tokens: issued, revoked, a bearer token refused, and a valid one used outside its scopes (both throttled).
  'ops-token-issue', 'ops-token-revoke', 'ops-auth-refused', 'ops-scope-refused',
  // Viewer tokens (design 2026-11-05): never the token, its full fingerprint or its ciphertext.
  'viewer-token-create', 'viewer-token-validity', 'viewer-token-revoke', 'viewer-token-accounts', 'viewer-token-delete', 'viewer-token-copy',
  // Camera name sync (design 2026-11-06): a camera record took the name its camera reported through its proxy.
  'camera-name-synced',
  // PoE switches (design 2026-11-07): the switch record, and what powers a camera.
  'switch-create', 'switch-update', 'switch-move', 'switch-delete', 'switch-test', 'camera-power-set', 'camera-power-verify', 'camera-power-cycle', 'camera-power-cycle-forced', 'switch-survey',
  // Remove camera / Decommission proxy (spec 2026-11-08): the proxy's answer, and the record deleted with it.
  'camera-remove', 'proxy-unenroll',
  // A viewer token's role (viewer or admin, spec 2026-11-08 A4/B6).
  'viewer-token-role',
] as const;
