# Skifteportalen API change monitor

A once-daily GitHub Actions job that sends Discord notifications when Skifteportalen's
[API documentation page](https://domstoldk.euwest01.umbraco.io/selvbetjening/blanketter-og-vejledninger/minskiftesagdk/api-tilslutning-til-skifteportalen/)
or its linked documents change.

## What it watches

- Article text, announcements, deprecations, release dates, link destinations and titles.
- All downloadable article links, including YAML specs, PDFs, integration guides,
  and empty legacy CMS anchors. Collapsed accordion content is included.
- SHA-256 hashes of downloaded bytes, detecting files replaced at the same URL.
- Added/removed links and documents becoming unavailable (404/410) or recovering.

Navigation, footer, scripts, cookie banners, styling and whitespace are excluded.
The first successful run sends a setup confirmation and establishes the baseline.
Unchanged runs send nothing. Update alerts include document links and a bounded
article diff; they do not perform semantic OpenAPI compatibility analysis.

## Run on GitHub Actions

The workflow in [monitor.yml](./.github/workflows/monitor.yml) runs daily at
**07:07 UTC** (08:07 CET in winter, 09:07 CEST in summer) and can also be started
manually from the repository's **Actions** tab. GitHub scheduled workflows use
UTC and may be delayed during busy periods, so this is not an exact-time alerting
service.

1. Push this project to a GitHub repository. A public repository is eligible for
   free standard GitHub-hosted runner usage.
2. In Discord, create a channel webhook under **Edit Channel → Integrations →
   Webhooks**.
3. In the repository, open **Settings → Secrets and variables → Actions** and
   add this **repository secret**:

   | Secret name | Value |
   | --- | --- |
   | `DISCORD_WEBHOOK_URL` | Discord webhook URL |

   Never put the secret values in workflow files, source code, or commits.
4. In **Settings → Actions → General**, make sure workflows are allowed to run.
   The workflow grants its `GITHUB_TOKEN` write access to repository contents so
   it can maintain the state branch. Protect the default branch and only merge
   trusted workflow changes: anyone able to modify and run the workflow could
   potentially expose its secrets.
5. Open **Actions → Skifteportalen monitor → Run workflow** to verify the setup.
   The first successful run sends a setup confirmation and establishes the
   baseline. Check the run's logs for `Skifteportalen monitor: initialized`.
   The workflow creates the `monitor-state` branch and snapshot file
   automatically.

Once the Actions workflow is verified, disable or delete the old Render cron
service to avoid duplicate alerts. The workflow serializes its own scheduled
and manual runs.

### State storage and cost

The current comparison baseline is stored at
`.monitor-state/snapshot.json` on a dedicated `monitor-state` branch. The
workflow creates the branch and file on its first successful run, then commits
an updated snapshot only after notifying about a change. It is one current
snapshot file, not a history table; Git retains earlier versions in that
branch's commit history. The snapshot contains the public article text,
document URLs, hashes, statuses and check time, but no credentials or downloaded
document bodies. Its size is capped below GitHub's 1 MB Contents API response
limit. Delete the `monitor-state` branch only if you intentionally want to reset
the baseline.

The hosted workflow uses GitHub's automatically provided `GITHUB_TOKEN` with
`contents: write`; no personal access token, external database, Actions
variable, or artifact retention is needed.

Standard GitHub-hosted runners are free for public repositories. Check GitHub's
[Actions billing documentation](https://docs.github.com/en/billing/concepts/product-billing/github-actions)
for current terms.

### Failure behavior

- Network requests time out after 30 seconds; downloads are capped at 15 MiB each.
  Safe reads retry up to three times on network failures, HTTP 429 or 5xx.
  State writes are not retried automatically to avoid duplicate or conflicting
  commits. Documents are fetched sequentially.
- Linked documents returning 404/410 are recorded and reported, including those
  already unavailable on initialization. Other download failures, empty/HTML
  document responses, missing article/spec sections and corrupt stored state fail
  the run without replacing the baseline.
- All change messages must reach Discord before the baseline advances. Discord
  rate limits are retried; ambiguous network/server errors are not immediately
  retried because the message may already have arrived.
- Delivery is **at least once**, not exactly once. Partial delivery, interruption
  or a failed baseline update after delivery can cause duplicate alerts next run.
- Failures exit nonzero and appear in the GitHub Actions run logs; the job also
  attempts a Discord failure alert when configuration is valid. Discord outages
  or invalid credentials can prevent that alert.
- Discord mentions are disabled, link embeds are suppressed, and long messages
  are split below Discord's 2,000-character limit.

Keep tokens in GitHub Actions secrets (or local environment variables). Never
commit a populated `.env`.

## Local development

Requires [Bun](https://bun.sh/) 1.4.2 or newer. The GitHub Actions workflow pins
Bun 1.4.2. Node.js and npm are not required for local development.

```sh
bun install --frozen-lockfile
bun run check
bun run test
bun run build
```

Commit [bun.lock](./bun.lock) alongside dependency changes. Use `bun add` or
`bun add --dev` to update dependencies; GitHub Actions installs from the frozen
lockfile.

Check the real page and every linked document without credentials, state writes,
or Discord messages:

```sh
bun run check:live
```

To run the actual monitor locally, copy [.env.example](./.env.example) to `.env`,
set the Discord webhook and repository name, and provide a fine-grained GitHub
token scoped to that repository with **Contents: read and write** permission as
`MONITOR_GITHUB_TOKEN`. Set `MONITOR_BASE_SHA` to a commit SHA from
`git rev-parse HEAD`, then build and run:

```sh
bun run start
```

Bun automatically loads the local `.env` file. Tests run with Bun's test runner
using its `node:test` compatibility, fake HTTP responses, and an in-memory store;
they never send real Discord messages or require GitHub credentials.
