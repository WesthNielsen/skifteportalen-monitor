# Skifteportalen API change monitor

A once-daily Render cron job that sends Discord notifications when Skifteportalen's
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

## Deploy on Render

1. Push this project to a Git repository connected to Render.
2. Follow [Set up Upstash Redis](#set-up-upstash-redis) below to create a free database
   and obtain its REST credentials.
3. In Discord, create a channel webhook under **Edit Channel → Integrations → Webhooks**.
4. Create a Render **Blueprint** from this repository. [render.yaml](./render.yaml)
   defines the cron job and prompts for:

   | Variable | Value |
   | --- | --- |
   | `DISCORD_WEBHOOK_URL` | Discord webhook URL (secret) |
   | `UPSTASH_REDIS_REST_URL` | `https://YOUR_DATABASE.upstash.io` |
   | `UPSTASH_REDIS_REST_TOKEN` | Upstash read/write REST token (secret) |

5. Deploy, then use **Trigger Run** to verify the initial Discord message.
   Check Render logs for `Skifteportalen monitor: initialized`.

The schedule is **`0 7 * * *` (07:00 UTC)**: 08:00 CET in winter and
09:00 CEST in summer. This is intentionally fixed UTC, not daylight-saving-aware.
Render supplies a single-run guarantee for each cron service; deploy only one
job per `STATE_KEY`.

### Set up Upstash Redis

1. Sign in or create an account at the [Upstash Console](https://console.upstash.com/redis).
2. On the **Redis** tab, choose **Create Database**. Name it, for example,
   `skifteportalen-monitor`.
3. Choose a primary region close to the Render job's **Frankfurt** region
   (prefer Frankfurt if available). A single region is sufficient for this job.
4. Continue to the plan selection, choose **Free**, and create the database.
   No paid plan or additional read regions are needed.
5. Open the database details and find the **REST API** connection section.
   Copy the values named `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN`.
   Use the **read/write token**, not the read-only token. The URL must look like
   `https://YOUR_DATABASE.upstash.io`, not a `redis://` or `rediss://` address.
6. Enter these values as environment variables when Render's Blueprint prompts
   for them. For local runs, put them in `.env` using [.env.example](./.env.example)
   as the template. Do not paste credentials into source code or commit `.env`.
7. Leave `STATE_KEY` at `skifteportalen:monitor:v1` unless you need a separate
   baseline. No tables, migrations, manual keys, or Upstash SDK installation
   are required: the job uses Upstash's REST API.
8. Trigger the Render job once. After the Discord initialization message arrives,
   open Upstash's **Data Browser** and find `skifteportalen:monitor:v1`.
   It should contain a JSON snapshot with no expiry. Trigger the job again;
   if the source has not changed, it should log `unchanged` and send no message.

If initialization fails, inspect the Render logs: HTTP 401 usually indicates an
incorrect REST token; a write failure can indicate a read-only token. Verify that
the REST URL and token belong to the same database. Do not delete the snapshot key
unless you intentionally want to reset the baseline. This database holds durable
monitor state, not disposable cache data; keep automatic eviction disabled.

See Upstash's [getting-started guide](https://upstash.com/docs/redis/overall/getstarted)
for the current console workflow.

### Persistence and cost

Render cron jobs cannot use persistent disks; local files disappear between runs.
The last successful snapshot is therefore stored as a single Redis key with
**no expiry**, independent of deployments. Only article text, URLs, document hashes,
statuses and the snapshot timestamp are stored, not entire document bodies.
The optional `STATE_KEY` defaults to `skifteportalen:monitor:v1`; use a different key
for an independent monitor. Deleting the key deliberately resets the baseline.

[Upstash's free plan](https://upstash.com/pricing/redis) currently includes 250 MB
and 500,000 commands/month. This monitor normally needs about 30 GETs/month plus
one SET per changed run, well within that allowance. Confirm current provider terms
and database retention/eviction settings before deployment.
[Neon PostgreSQL](https://neon.com/pricing) is another free persistence option,
but is not needed by this implementation.

**Render cron compute is not free**: Render documents a $1/month minimum per cron
service, plus usage. There is no paid Render database requirement.

### Failure behavior

- Network requests time out after 30 seconds; downloads are capped at 15 MiB each.
  Safe reads and idempotent Redis commands retry up to three times on network
  failures, HTTP 429 or 5xx. Documents are fetched sequentially.
- Linked documents returning 404/410 are recorded and reported, including those
  already unavailable on initialization. Other download failures, empty/HTML
  document responses, missing article/spec sections and corrupt stored state fail
  the run without replacing the baseline.
- All change messages must reach Discord before the baseline advances. Discord
  rate limits are retried; ambiguous network/server errors are not immediately
  retried because the message may already have arrived.
- Delivery is **at least once**, not exactly once. Partial delivery, interruption
  or a failed Redis write after delivery can cause duplicate alerts next run.
- Failures exit nonzero, appear in Render logs, and attempt a Discord failure alert
  when configuration is valid. Configure Render's failure notifications too,
  since Discord/Upstash outages or invalid credentials can prevent that alert.
- Discord mentions are disabled, link embeds are suppressed, and long messages
  are split below Discord's 2,000-character limit.

Keep tokens in Render environment variables. Never commit a populated `.env`.

## Local development

Requires [Bun](https://bun.sh/) 1.4.2 or newer. Render pins Bun 1.4.2 via
`BUN_VERSION` while keeping `runtime: node`, Render's native JavaScript environment.
Node.js and npm are not required for local development.

```sh
bun install --frozen-lockfile
bun run check
bun run test
bun run build
```

Commit [bun.lock](./bun.lock) alongside dependency changes. Use `bun add` or
`bun add --dev` to update dependencies; Render installs from the frozen lockfile.

Check the real page and every linked document without credentials, state writes,
or Discord messages:

```sh
bun run check:live
```

To run the actual monitor, copy [.env.example](./.env.example) to `.env`, populate
the three credentials, build, and run:

```sh
bun run start
```

Bun automatically loads the local `.env` file. Tests run with Bun's test runner
using its `node:test` compatibility, fake HTTP responses, and an in-memory store;
they never send real Discord messages or require database credentials.
