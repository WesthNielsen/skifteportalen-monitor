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
};
const config = readConfig(env);
const stored: Snapshot = {
  version: 1,
  sourceUrl: SOURCE_URL,
  checkedAt: "2026-11-09T07:07:00.000Z",
  pageText: "API",
  resources: [{ url: "https://example.com/spec.yaml", label: "Spec", status: 200, hash: "a".repeat(64) }],
};
const variableUrl =
  "https://api.github.com/repos/owner/repo/actions/variables/SKIFTEPORTAL_MONITOR_SNAPSHOT";

test("validates required configuration and rejects wrong credential destinations", () => {
  assert.throws(() => readConfig({}), /Set DISCORD/u);
  assert.throws(() => readConfig({ ...env, DISCORD_WEBHOOK_URL: "https://example.com/webhook" }),
    /HTTPS Discord/u);
  assert.throws(() => readConfig({ ...env, GITHUB_REPOSITORY: "owner/repo/path" }), /Set DISCORD/u);
});

test("GitHub Actions variable store loads, creates and updates the current snapshot", async () => {
  let persisted: string | null = null;
  const calls: string[] = [];
  const store = createStore(config, async (input, init) => {
    const headers = new Headers(init?.headers);
    assert.equal(headers.get("authorization"), "Bearer test-write-token");
    const url = String(input);
    const method = init?.method;
    calls.push(`${method} ${url}`);
    if (method === "GET") {
      return persisted === null ? new Response(null, { status: 404 }) : Response.json({ value: persisted });
    }
    if (method === "PATCH") {
      if (persisted === null) return new Response(null, { status: 404 });
      persisted = JSON.parse(String(init?.body)).value as string;
      return new Response(null, { status: 204 });
    }
    persisted = JSON.parse(String(init?.body)).value as string;
    return new Response(null, { status: 201 });
  });
  assert.equal(await store.load(), null);
  await store.save(stored);
  assert.deepEqual(await store.load(), stored);
  await store.save({ ...stored, checkedAt: "2026-11-10T07:07:00.000Z" });
  assert.deepEqual(calls, [
    `GET ${variableUrl}`,
    `PATCH ${variableUrl}`,
    "POST https://api.github.com/repos/owner/repo/actions/variables",
    `GET ${variableUrl}`,
    `PATCH ${variableUrl}`,
  ]);
});

test("only missing GitHub variables initialize; corrupt, incompatible and error responses fail", async () => {
  assert.equal(await createStore(config, async () => new Response(null, { status: 404 })).load(), null);
  assert.equal(await createStore(config, async () => Response.json({ value: "" })).load(), null);
  for (const value of ["not-json", "{}", JSON.stringify({ ...stored, version: 2 }),
    JSON.stringify({ ...stored, resources: [{ ...stored.resources[0], status: 200, hash: null }] })]) {
    await assert.rejects(createStore(config, async () => Response.json({ value })).load(),
      /Stored snapshot/u);
  }
  await assert.rejects(createStore(config, async () => Response.json({ error: "ERR" })).load(),
    /invalid Actions variable response/u);
  await assert.rejects(createStore(config, async () => new Response(null, { status: 403 })).load(),
    /HTTP 403/u);
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

test("full workflow persists in GitHub and alerts on same-URL spec replacement", async () => {
  let persisted: string | null = null;
  let spec = "openapi: 3.0.0\ninfo:\n  version: 1.0.0";
  const deliveries: string[] = [];
  const fetcher: Fetch = async (input, init) => {
    const url = String(input);
    if (url.includes("/actions/variables")) {
      if (init?.method === "GET") {
        return persisted === null
          ? new Response(null, { status: 404 })
          : Response.json({ value: persisted });
      }
      if (init?.method === "PATCH") {
        if (persisted === null) return new Response(null, { status: 404 });
        persisted = JSON.parse(String(init.body)).value as string;
        return new Response(null, { status: 204 });
      }
      persisted = JSON.parse(String(init?.body)).value as string;
      return new Response(null, { status: 201 });
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
