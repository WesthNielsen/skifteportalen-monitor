import assert from "node:assert/strict";
import { test } from "node:test";
import { createNotifier, createStore, readConfig } from "../src/services.ts";
import { request, retryDelay } from "../src/http.ts";
import { SOURCE_URL } from "../src/model.ts";
import { collectSnapshot, runMonitor } from "../src/monitor.ts";
import type { Fetch } from "../src/http.ts";
import type { Snapshot } from "../src/model.ts";

const env = {
  DISCORD_WEBHOOK_URL: "https://discord.com/api/webhooks/123456/test-token",
  GITHUB_REPOSITORY: "owner/repo",
  MONITOR_GITHUB_TOKEN: "test-write-token",
  MONITOR_BASE_SHA: "b".repeat(40),
};
const config = readConfig(env);
const stored: Snapshot = {
  version: 1,
  sourceUrl: SOURCE_URL,
  checkedAt: "2026-11-09T07:07:00.000Z",
  pageText: "API",
  resources: [{ url: "https://example.com/spec.yaml", label: "Spec", status: 200, hash: "a".repeat(64) }],
};
const stateUrl = "https://api.github.com/repos/owner/repo/contents/.monitor-state/snapshot.json";

test("validates required configuration and rejects wrong credential destinations", () => {
  assert.throws(() => readConfig({}), /Set DISCORD/u);
  assert.throws(() => readConfig({ ...env, DISCORD_WEBHOOK_URL: "https://example.com/webhook" }),
    /HTTPS Discord/u);
  assert.throws(() => readConfig({ ...env, GITHUB_REPOSITORY: "owner/repo/path" }), /Set DISCORD/u);
  assert.throws(() => readConfig({ ...env, MONITOR_BASE_SHA: "invalid" }), /Set DISCORD/u);
});

test("GitHub state branch store loads, creates and updates the current snapshot", async () => {
  let persisted: string | null = null;
  let branchExists = false;
  const calls: string[] = [];
  const store = createStore(config, async (input, init) => {
    const headers = new Headers(init?.headers);
    assert.equal(headers.get("authorization"), "Bearer test-write-token");
    const url = String(input);
    const method = init?.method;
    calls.push(`${method} ${url}`);
    if (url.endsWith("/git/ref/heads/monitor-state") && method === "GET") {
      return branchExists ? Response.json({ ref: "refs/heads/monitor-state" })
        : new Response(null, { status: 404 });
    }
    if (url.endsWith("/git/refs") && method === "POST") {
      branchExists = true;
      return new Response(null, { status: 201 });
    }
    if (url.startsWith(stateUrl) && method === "GET") {
      return persisted === null ? new Response(null, { status: 404 }) : Response.json({
        sha: "blob-sha",
        content: Buffer.from(persisted).toString("base64"),
        encoding: "base64",
      });
    }
    if (url === stateUrl && method === "PUT") {
      persisted = Buffer.from(JSON.parse(String(init?.body)).content as string, "base64").toString("utf8");
      return new Response(null, { status: calls.filter((call) => call.startsWith("PUT ")).length === 1 ? 201 : 200 });
    }
    throw new Error(`Unexpected request: ${method} ${url}`);
  });
  assert.equal(await store.load(), null);
  await store.save(stored);
  assert.deepEqual(await store.load(), stored);
  await store.save({ ...stored, checkedAt: "2026-11-10T07:07:00.000Z" });
  assert.deepEqual(calls, [
    `GET ${stateUrl}?ref=monitor-state`,
    "GET https://api.github.com/repos/owner/repo/git/ref/heads/monitor-state",
    "POST https://api.github.com/repos/owner/repo/git/refs",
    `GET ${stateUrl}?ref=monitor-state`,
    `PUT ${stateUrl}`,
    `GET ${stateUrl}?ref=monitor-state`,
    "GET https://api.github.com/repos/owner/repo/git/ref/heads/monitor-state",
    `GET ${stateUrl}?ref=monitor-state`,
    `PUT ${stateUrl}`,
  ]);
});

test("only missing state files initialize; corrupt, incompatible and error responses fail", async () => {
  assert.equal(await createStore(config, async () => new Response(null, { status: 404 })).load(), null);
  for (const value of ["not-json", "{}", JSON.stringify({ ...stored, version: 2 }),
    JSON.stringify({ ...stored, resources: [{ ...stored.resources[0], status: 200, hash: null }] })]) {
    await assert.rejects(createStore(config, async () => Response.json({
      sha: "blob-sha",
      content: Buffer.from(value).toString("base64"),
      encoding: "base64",
    })).load(),
      /Stored snapshot/u);
  }
  await assert.rejects(createStore(config, async () => Response.json({ error: "ERR" })).load(),
    /invalid state file response/u);
  await assert.rejects(createStore(config, async () => Response.json({
    message: "Resource not accessible by integration",
  }, { status: 403 })).load(), /HTTP 403 — Resource not accessible by integration/u);
  await assert.rejects(createStore(config, async () => Response.json({
    message: "token test-write-token should not appear",
  }, { status: 403 })).load(), (error: Error) => {
    assert.match(error.message, /\[REDACTED\]/u);
    assert.doesNotMatch(error.message, /test-write-token/u);
    return true;
  });
});

test("Discord waits for acknowledgement, disables mentions and suppresses link embeds", async () => {
  const delivered: unknown[] = [];
  const notifier = createNotifier(config.webhookUrl, async (url, init) => {
    assert.equal(new URL(String(url)).searchParams.get("wait"), "true");
    delivered.push(JSON.parse(String(init?.body)));
    return Response.json({ id: "message-id" });
  });
  await notifier(["@everyone update", "second part"]);
  assert.deepEqual(delivered, [
    { content: "@everyone update", allowed_mentions: { parse: [] }, flags: 4 },
    { content: "second part", allowed_mentions: { parse: [] }, flags: 4 },
  ]);
});

test("Discord retries explicit rate limits but not ambiguous server/network failures", async () => {
  let attempts = 0;
  const delays: number[] = [];
  await createNotifier(config.webhookUrl, async () => {
    attempts++;
    return attempts === 1
      ? new Response("limited", { status: 429, headers: { "Retry-After": "2" } })
      : Response.json({ id: "ok" });
  }, async (delay) => { delays.push(delay); })(["Update"]);
  assert.equal(attempts, 2);
  assert.deepEqual(delays, [2000]);
  attempts = 0;
  await assert.rejects(createNotifier(config.webhookUrl, async () => {
    attempts++;
    return new Response("error", { status: 500 });
  })(["Update"]), /Discord: HTTP 500/u);
  assert.equal(attempts, 1);
});

test("Discord enforces message limits and bounds rate-limit retries", async () => {
  const notifier = createNotifier(config.webhookUrl, async () =>
    new Response("limited", { status: 429 }), async () => {});
  await assert.rejects(notifier([""]), /between 1 and 2000/u);
  await assert.rejects(notifier(["x".repeat(2001)]), /between 1 and 2000/u);
  await assert.rejects(notifier(["Update"]), /after three attempts/u);
});

test("source requests retry transient failures but permanent errors fail immediately", async () => {
  let attempts = 0;
  const response = await request("https://example.com", {}, "Source", {
    fetch: async () => {
      attempts++;
      return attempts < 3 ? new Response("error", { status: 503 }) : new Response("ok");
    },
    sleep: async () => {},
  });
  assert.equal(response.body.toString(), "ok");
  assert.equal(attempts, 3);
  attempts = 0;
  await assert.rejects(request("https://example.com", {}, "Source", {
    fetch: async () => {
      attempts++;
      return new Response("not found", { status: 404 });
    },
  }), /HTTP 404/u);
  assert.equal(attempts, 1);
});

test("network failures never disclose secret URLs and oversized bodies are rejected", async () => {
  await assert.rejects(request(config.webhookUrl, {}, "Discord", {
    retry: false,
    fetch: async () => { throw new Error(`Sensitive URL: ${config.webhookUrl}`); },
  }), (error: Error) => {
    assert.doesNotMatch(error.message, /test-token|discord.com/u);
    return /request failed/u.test(error.message);
  });
  await assert.rejects(request("https://example.com", {}, "Source", {
    retry: false,
    fetch: async () => new Response("large", { headers: { "content-length": String(16 * 1024 * 1024) } }),
  }), /download limit/u);
  assert.equal(retryDelay("999999", 0), 30_000);
  assert.equal(retryDelay(null, 1), 2000);
});

test("full workflow persists on a GitHub state branch and alerts on same-URL spec replacement", async () => {
  let persisted: string | null = null;
  let branchExists = false;
  let spec = "openapi: 3.0.0\ninfo:\n  version: 1.0.0";
  const deliveries: string[] = [];
  const fetcher: Fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith("/git/ref/heads/monitor-state") && init?.method === "GET") {
      return branchExists ? Response.json({ ref: "refs/heads/monitor-state" })
        : new Response(null, { status: 404 });
    }
    if (url.endsWith("/git/refs") && init?.method === "POST") {
      branchExists = true;
      return new Response(null, { status: 201 });
    }
    if (url.startsWith(stateUrl) && init?.method === "GET") {
      return persisted === null ? new Response(null, { status: 404 }) : Response.json({
        sha: "blob-sha",
        content: Buffer.from(persisted).toString("base64"),
        encoding: "base64",
      });
    }
    if (url === stateUrl && init?.method === "PUT") {
      persisted = Buffer.from(JSON.parse(String(init.body)).content as string, "base64").toString("utf8");
      return new Response(null, { status: persisted ? 200 : 201 });
    }
    if (url.startsWith(config.webhookUrl)) {
      const message: { content: string } = JSON.parse(String(init?.body));
      deliveries.push(message.content);
      return Response.json({ id: String(deliveries.length) });
    }
    if (url === SOURCE_URL) {
      return new Response(`<div id="articlecontent"><article>
        <p>Current API</p><a href="/media/spec.yaml">Spec</a>
        </article></div>`);
    }
    assert.equal(url, new URL("/media/spec.yaml", SOURCE_URL).href);
    return new Response(spec);
  };
  const run = () => runMonitor(createStore(config, fetcher),
    () => collectSnapshot(fetcher), createNotifier(config.webhookUrl, fetcher));
  assert.equal(await run(), "initialized");
  assert.equal(await run(), "unchanged");
  spec += "\n  description: Deprecated endpoint removed";
  assert.equal(await run(), "changed");
  assert.equal(await run(), "unchanged");
  assert.equal(deliveries.length, 2);
  assert.match(deliveries[1] ?? "", /Document content changed/u);
  assert.notEqual(persisted, null);
});
