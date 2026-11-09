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

