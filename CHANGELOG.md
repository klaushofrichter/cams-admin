# Changelog

Release notes are cut from `## [Unreleased]` by the deploy workflow, which
then empties it on `main`.

## [Unreleased]

- The account page's Proxies table is tidied: columns Proxy, Host ("This
  network · PC" instead of `local-host (pc)`), State, Proxy GUI (a link, marked
  "LAN" with the full warning in its tooltip) and Viewer address (how cams
  viewers reach the proxy; hidden on phones). A missing address shows a muted
  "–". The dashboard labels the same address "GUI" and marks it the same way.
