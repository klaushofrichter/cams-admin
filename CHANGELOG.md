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
- A chained switch (another switch on one port, so a survey finds two or more cameras behind it) is shown as a configuration issue: on the switch, as "trunk (n cameras)" in its port table, and on the dashboard. Cameras behind such a port are not mapped to it, and a check that finds a camera there keeps looking on the other switches.
- The audit log records every power-cycle against its camera (start, the retry on another port, the outcome), each power check and its result, and each survey with its summary.
- The cams viewer's admin assistant tools can list the switches and what powers each camera.

