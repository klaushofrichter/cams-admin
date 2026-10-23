# Camera move, step 4: copy back on cancel, Archive first, completeness check, records age out

Status: approved by Klaus 2026-10-23 ("All ok", decisions 1-5 as recommended, plus the Archive note in §2). Builds on the camera-move design (cam-proxy
`docs/superpowers/specs/2026-10-21-camera-move-design.md`) and
`2026-10-22-operations-and-move-tokens-design.md`.

## Why

Klaus, 2026-10-23:

- The original content stays on the original proxy until the whole transfer is
  complete; only then is it deleted.
- A cancel after the switch-over must not lose what the camera recorded on the
  new proxy meanwhile: that content is copied back to the original proxy. The
  copy back can't be cancelled ("cancel a cancellation" is not allowed).
- After a transfer, an inventory check shows whether everything arrived and
  whether anything missing can still be recovered; then the move concludes.
- Archive items are what users care about most: they go first.
- An ended move's record ages out with retention: once retention has passed,
  none of the original content exists any more anyway.

## What exists today (measured)

- The source deletes the camera's content only at `move.finish`, after the copy
  (or after **End transfer**, which gives up what isn't copied yet, Archive
  included).
- Cancel after the switch-over: the camera goes back to the source at once
  (`giveBack`: leaf, FTP). The target then deletes what the move copied
  (`copied: 'delete'`) or lets it age out; what the target captured itself is
  left there and ages out. Nothing is copied back.
- Copy order: newest day first, then clips, events, checks, archive, stills.
- The copier is role-neutral (manifest, chunks, files, import by natural key);
  the token guard, endpoints and commands are role-specific.
- cams-admin never deletes `moves` rows; cam-proxy keeps a 7-day tombstone.

## 1. Copy back after a cancel

A cancel after the switch-over becomes two parts:

1. **Camera back** (as today, unchanged): the source runs the camera again at
   once, so new recordings land on the original proxy from that moment.
2. **Copy back** (new): the original proxy pulls from the new proxy everything
   the new proxy captured for this camera between the switch-over and the
   camera's return, using the same copier, checks (size, SHA-256) and resume
   as a normal move.

How:

- cams-admin runs the copy back as a **return move** linked to the cancelled
  one (`returnOf: <moveId>`): roles swapped (the new proxy is the return's
  source, the original proxy its target), a fresh move token bound to the
  original proxy's address, plan "everything, all space" (it is the original
  proxy's own camera; no budget, no approval, no switch-over, no camera, leaf
  or FTP steps — the camera is already back).
- The return's manifest lists only content **the new proxy captured itself**:
  everything of that camera on the new proxy that is not in this move's
  import log (row maps and the landed-files log). No time window: that avoids
  clock skew, and an imported item that was changed on the new proxy (a
  renamed Archive item) goes back too. Anything the original already has is
  skipped by its natural key. Served as filtered chunks, not whole days.
- The new proxy keeps its move record, import log and landed log after the
  cancel (`returnPending`, like `cancelPending`) until the return is checked;
  today they are deleted at the cancel.
- cams-admin: the cancelled move ends at `cancelled` as today; the return is
  its own move row (`return_of`), phase `returning` → `returned`, so the
  one-move-per-proxy rules hold (the return blocks other moves on both
  proxies while it runs, as any move does). Migration: `return_of`, the new
  phases (table rebuild for the CHECK list). The return's target address is
  the original proxy's, as today. A return move
  can't be cancelled and has no End transfer; it retries until done (as a
  stalled copy does today). A proxy offline for a long time just delays it.
- When the return is complete and checked (§3): the new proxy deletes what the
  return verified on the original and what the move had imported (rows whose
  natural key still matches, landed files). Never a blanket delete of the
  camera id: a local admin may already have added another camera under it. The
  "Delete what was copied / Let it age out" choice goes away for a cancel
  after the switch-over. Items that failed their checks three times stay on
  the new proxy and age out there; the check names them.
- A cancel before the switch-over is unchanged (nothing to copy back).

## 2. Archive first

- The copy order becomes: all Archive items first (newest day first), then
  the rest as today (newest day first, then clips, events, checks, stills).
  Same order on both sides (cam-proxy `inventory.ts` and `copier.ts`), also for
  the copy back.
- **End transfer** waits until the Archive part is copied: the button says
  "End after Archive" while Archive chunks are still pending, and the move
  ends once they are verified. Archive is never given up. (My call; the
  alternative is to let End transfer drop Archive as today.)
- "Fit" plans: Archive counts first against the space, then newest days.
- **Why an item is there** (Klaus): an Archive item a move brought in carries
  a note "Moved here from <proxy> by move <id> on <date>"; an Archive item a
  move could not copy, kept on the original proxy, carries "Kept here: the
  move to <proxy> on <date> couldn't copy it (<reason>)". Stored in the item's
  metadata (`move: {moveId, from|to, at, kept?, reason?}`), shown on the
  Archive item in cam-proxy and cams; a copy back marks items the same way.

## 3. Completeness check before the move concludes

Before `move.finish` (and before the copy back concludes), the receiving proxy
compares, per chunk, the sender's manifest (files, bytes, rows) with what it
holds and verified:

- complete → the move finishes as today;
- missing items still on the sender (recoverable) → one more copy pass for
  exactly those, then check again; still missing after that → reported;
- items that failed or vanished (the sender's retention deleted them
  meanwhile) → reported, not retried.

The result is stored with the move (`check: {complete, missing, recovered,
failed, expired}` counts per kind) and shown on the Moves page and
`/diag/moves`; audited as `move-check`. Then the move concludes; nothing
waits for a person. The sender's token is still valid during the check
(it is revoked at finish).

## Decisions for Klaus (with my recommendation)

1. Items the check reports as failed or missing at the end: **keep them on the
   source until its retention removes them** (a selective delete), instead of
   deleting everything of the camera as today. Recommended.
2. Archive items that can't be copied (failed three times, or a move that
   fails during the copy): same as 1, **they stay on the source**; the move
   still concludes. Recommended.
3. A return that can never finish (a proxy gone for good): a sysadmin-only
   **Give up copy back** in cams-admin, typed confirmation, deletes nothing on
   either proxy (content ages out where it is). Recommended.
4. While a return runs it blocks other moves on both proxies (as any move
   does today). Recommended for now; per-camera later if the multi-camera
   host needs it.
5. A return that doesn't fit on the original: **pause and report** (never let
   storage pressure delete the original's own older content for it).
   Recommended.

## 4. Ended moves age out

- cams-admin deletes an ended move (row and chunk states) after the camera's
  **longest content retention** on the proxy that holds the camera now: the
  largest of `retention.stillsDays`, `previewsDays`, `clipsDays`, `eventsDays`, at least 7
  days. The proxy reports these days with its `move.phase finished`/
  `cancelled` event (new optional field `keepDays`); without it, 30 days.
- Archive items keep their own expiry and are not counted (they can outlive
  the record; the record isn't needed for them).
- Never pruned while its cleanup is still pending or a return is linked to it.
- cam-proxy's tombstone (7 days) stays as it is: it only answers a repeated
  finish or cancel.
- Audit rows about the move stay (the audit log has its own retention).

## Rollout

cam-proxy first (return endpoints, captured-since manifest, Archive-first
order, the check, `keepDays`), contract change in cams-admin `contract/v1`
first as usual; then cams-admin (return move, phases, End after Archive,
pruning, UI). Tests: unit and e2e for each, the localstack move-check gets a
cancel-after-switch-over scenario with content captured on the target.
A real-camera test (cancel during a cam4 move) needs Klaus's OK.

## Out of scope

Moves across accounts; CA rotation without a person (cams #268).
