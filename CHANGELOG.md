# Changelog

Release notes are cut from `## [Unreleased]` by the deploy workflow, which
then empties it on `main`.

## [Unreleased]

### Added
- PoE switches: register a switch per account (name, address, ports, the proxy that operates it), test it, and see which camera is on which port. The switch password stays on the proxy.
- A Switches tab to add, test, edit, move to another proxy, survey and remove switches, with a port table (camera, PoE, watts, link). Removing a switch switches PoE back on first and says which cameras become unknown.
- Each camera shows where its power comes from (PoE switch and port, data only, power adapter, unknown) with Verify, Find, Declare adapter, Power-cycle and Force power-cycle. A normal power-cycle checks the port first; the forced one asks first and cuts power without checking.
- A daily survey (03:30) and a survey after a switch is tested, a camera is added or its address changes keep the port map current; a camera a survey no longer sees is marked "not seen in the last survey".
- The proxy's own power-cycle action is no longer offered for a camera whose power cams-admin knows.

