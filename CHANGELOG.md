# Changelog

Release notes are cut from `## [Unreleased]` by the deploy workflow, which
then empties it on `main`.

## [Unreleased]

### Fixed
- Proxy tokens after a restore from an older backup: when the proxy answers our token set as stale at the same revision number (it holds another set with that number), its next heartbeat no longer confirms that set as ours and clears the "proxy ahead" guard; token changes wait for an admin's confirmation, also after a restart.
- cams instances: an instance that reaches a pinned proxy over plain http (not loopback), such as cams in the cluster reaching its proxy in-cluster, gets that proxy without its CA pins in its snapshot, so it no longer refuses the whole account (cams takes pins only over https or loopback; snapshot format 6). The proxy page warns under the CA fingerprints which instances get no pins, the instance page warns on such a route, and `/diag/proxies` lists them as `pinsNotSentTo`.
### Changed
- Operations tokens: a write made with one is audited with the token's name as well as its hash prefix (actor `ops-token:1a2b3c4d (mac script)`; it was `ops-token:1a2b3c4d`). `/diag/ops-tokens` keeps showing the names.
- PoE switches: Force power-cycle asks for the typed word `power-cycle` too, as the plain power-cycle does (it is the riskier of the two).
- PoE switches: a camera deleted while a power-cycle its proxy asked for is running: the proxy still gets the answer (it used to wait for its 5-minute timeout).
- Proxy settings: a camera's first `stills.intervalS` and its Reset are no longer refused by cams-admin's own check. A camera without its own interval uses the host's `stills.intervalS` (as on cam-proxy), so its first interval may be anything up to the host's, and a Reset passes unless the host's is longer. The refusal reads "a remote change may only shorten the interval; a longer one is a local change", as cam-proxy's does.
### Changed
- Proxy settings: the capture intervals (`stills.intervalS`, `events.poll.intervalS`, a camera's `stills.intervalS`) can only be made shorter from cams-admin (a longer interval thins out capture); a longer one is set at the proxy. cam-proxy follows in its next contract update.

### Fixed
- Proxy settings: a proxy whose settings keep changing, or whose settings can't be read, is re-read less often after 5 automatic reads in a row (every 2, 4, 8 … up to 30 minutes), and its Settings card says so; a change made from cams-admin, or an hour without changes, starts over. Reload still reads at once.
- Moves: after Start move, the card follows the source proxy's answer; a request that never reached the source, got no answer within 15 minutes, or was refused says so ("The source proxy did not answer within 15 minutes, so the move did not start. …") instead of leaving "Move requested.".
- Moves: the move detail shows the request's bounds as "Auto-approve bounds: …" (it said "Auto-approved within: …" also when the source then waited for a person).
- Moves: a start refused by the precheck and made with an operations token is audited once per token per 10 minutes (the rest are counted), so a retrying script does not fill the audit log; a person's refusals are each still recorded.
- cams instances: the stored last report keeps only the fields the contract names.
### Added
- Proxy pins API ("Use the reported pins"): `POST …/pins/from-report` takes an optional `{"keepPrevious": true}`, which keeps the current pin as the second one after a CA rotation, and refuses a report older than the offline limit (409 `report_stale`).

