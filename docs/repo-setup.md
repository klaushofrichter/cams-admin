# Repository setup (run once, by the session with Klaus's OK)

The settings below are GitHub settings, not files. They follow the Obsidian
note *Cluster/Building a New Service* and the other camera repos.

## Now (with the first code PR)

```sh
R=klaushofrichter/cams-admin
# Dependabot alerts and security updates (two switches; .github/dependabot.yml is the third)
gh api -X PUT repos/$R/vulnerability-alerts
gh api -X PUT repos/$R/automated-security-fixes
# Labels used by .github/dependabot.yml
gh label create dependencies --repo $R --color 0366d6 --force
gh label create ci --repo $R --color 5319e7 --force
# Delete head branches after merge; main is the default branch, unprotected
gh api -X PATCH repos/$R -f default_branch=main -F delete_branch_on_merge=true
```

## With the first release (creating `production`)

```sh
R=klaushofrichter/cams-admin
gh api -X POST repos/$R/git/refs -f ref=refs/heads/production -f sha="$(gh api repos/$R/git/ref/heads/main -q .object.sha)"
gh api -X PUT repos/$R/branches/production/protection --input - <<'JSON'
{ "required_status_checks": { "strict": true, "contexts": ["test", "e2e", "codeql"] },
  "enforce_admins": false,
  "required_pull_request_reviews": null,
  "restrictions": null,
  "allow_force_pushes": false,
  "allow_deletions": false }
JSON
```

`enforce_admins: false` is the standard (owner override on); never flip it
without Klaus asking. Promotion is a PR from `main` to `production`.
