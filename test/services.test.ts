import assert from "node:assert/strict";
import { createHash } from "node:crypto";
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
function fakeGitHub() {
  const commits = new Map<string, Map<string, string>>([[config.baseSha, new Map()]]);
  const trees = new Map<string, Map<string, string>>();
  const parents = new Map<string, string>();
  const treeWrites: string[][] = [];
  let head: string | null = null;
  let sequence = 0;
  let rejectUpdate = false;
  const fetcher: Fetch = async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method;
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer test-write-token");
    if (url.pathname.endsWith("/git/ref/heads/monitor-state") && method === "GET") {
      return head ? Response.json({ object: { sha: head } }) : new Response(null, { status: 404 });
    }
    if (url.pathname.endsWith("/git/refs") && method === "POST") {
      head = config.baseSha;
      return Response.json({ ref: "refs/heads/monitor-state" }, { status: 201 });
    }
    if (url.pathname.includes("/contents/") && method === "GET") {
      const path = url.pathname.split("/contents/")[1] ?? "";
      const content = commits.get(url.searchParams.get("ref") ?? "")?.get(path);
      if (content === undefined) return new Response(null, { status: 404 });
      if (new Headers(init?.headers).get("accept") === "application/vnd.github.raw+json") {
        return new Response(content);
      }
      return Response.json({ sha: "blob-sha", content: Buffer.from(content).toString("base64"), encoding: "base64" });
    }
    if (url.pathname.includes("/git/commits/") && method === "GET") {
      const sha = url.pathname.split("/").at(-1) ?? "";
      return commits.has(sha) ? Response.json({ tree: { sha } }) : new Response(null, { status: 404 });
    }
    if (url.pathname.endsWith("/git/trees") && method === "POST") {
      const body: { base_tree: string; tree: { path: string; content?: string; sha?: null }[] } =
        JSON.parse(String(init?.body));
      const files = new Map(commits.get(body.base_tree));
      treeWrites.push(body.tree.map((entry) => entry.path));
      for (const entry of body.tree) {
        if (entry.sha === null) files.delete(entry.path);
        else if (entry.content !== undefined) files.set(entry.path, entry.content);
        else throw new Error("Missing tree content");
      }
      const sha = `tree-${++sequence}`;
      trees.set(sha, files);
      return Response.json({ sha }, { status: 201 });
    }
    if (url.pathname.endsWith("/git/commits") && method === "POST") {
      const body: { tree: string; parents: string[] } = JSON.parse(String(init?.body));
      const files = trees.get(body.tree);
      if (!files || !body.parents[0]) throw new Error("Invalid commit");
      const sha = `commit-${++sequence}`;
      commits.set(sha, files);
      parents.set(sha, body.parents[0]);
      return Response.json({ sha }, { status: 201 });
    }
    if (url.pathname.endsWith("/git/refs/heads/monitor-state") && method === "PATCH") {
      const body: { sha: string; force: boolean } = JSON.parse(String(init?.body));
      if (rejectUpdate || body.force || parents.get(body.sha) !== head) {
        return new Response("Conflict", { status: 409 });
      }
      head = body.sha;
      return Response.json({ object: { sha: head } });
    }
    throw new Error(`Unexpected request: ${method} ${url.href}`);
  };
  return {
    fetcher,
    treeWrites,
    files: () => commits.get(head ?? "") ?? new Map<string, string>(),
    failUpdate: () => { rejectUpdate = true; },
    seed: (files: Map<string, string>) => {
      head = `seed-${++sequence}`;
      commits.set(head, files);
    },
  };
}

test("validates required configuration and rejects wrong credential destinations", () => {
  assert.throws(() => readConfig({}), /Set DISCORD/u);
  assert.throws(() => readConfig({ ...env, DISCORD_WEBHOOK_URL: "https://example.com/webhook" }),
    /HTTPS Discord/u);
  assert.throws(() => readConfig({ ...env, GITHUB_REPOSITORY: "owner/repo/path" }), /Set DISCORD/u);
  assert.throws(() => readConfig({ ...env, MONITOR_BASE_SHA: "invalid" }), /Set DISCORD/u);
});

test("GitHub state branch store loads, creates and updates the current snapshot", async () => {
  const github = fakeGitHub();
  const store = createStore(config, github.fetcher);
  assert.equal(await store.load(), null);
  await store.save(stored);
  assert.deepEqual(await store.load(), stored);
  await store.save({ ...stored, checkedAt: "2026-11-10T07:07:00.000Z" });
  assert.equal(github.treeWrites.length, 2);
  assert.deepEqual(await store.load(), { ...stored, checkedAt: "2026-11-10T07:07:00.000Z" });
});

test("migrates inline PDF text and stores large YAML baselines as separate atomic files", async () => {
  const github = fakeGitHub();
  const yaml = `\uFEFFopenapi: 3.0.0\r\n  title: Eksempel med æøå\r\n${"  value: example\n".repeat(55_000)}`;
  const hash = createHash("sha256").update(yaml).digest("hex");
  const legacy: Snapshot = {
    ...stored,
    resources: [
      { url: "https://example.com/guide.pdf", label: "Guide", status: 200, hash: "b".repeat(64), pdfText: "Old text" },
      { url: "https://example.com/spec.yaml", label: "Spec", status: 200, hash },
    ],
  };
  github.seed(new Map([[".monitor-state/snapshot.json", JSON.stringify(legacy)]]));
  const store = createStore(config, github.fetcher);
  assert.deepEqual(await store.load(), legacy);
  const updated: Snapshot = {
    ...legacy,
    resources: legacy.resources.map((resource) =>
      resource.url.endsWith(".yaml") ? { ...resource, yamlText: yaml } : resource),
  };
  await store.save(updated);
  const files = github.files();
  const state = files.get(".monitor-state/snapshot.json") ?? "";
  assert.ok(Buffer.byteLength(yaml) > 900 * 1024);
  assert.ok(Buffer.byteLength(state) < 900 * 1024);
  assert.doesNotMatch(state, /Old text|value: example/u);
  assert.equal(files.size, 3);
  assert.deepEqual(await createStore(config, github.fetcher).load(), updated);
  await store.save(updated);
  assert.deepEqual(github.treeWrites.at(-1), [".monitor-state/snapshot.json"]);
  const withoutPdf: Snapshot = { ...updated, resources: updated.resources.slice(1) };
  await store.save(withoutPdf);
  assert.equal(github.files().size, 2);
  assert.deepEqual(await createStore(config, github.fetcher).load(), withoutPdf);
});

test("failed or concurrent branch updates leave the existing snapshot and text intact", async () => {
  const github = fakeGitHub();
  const first = createStore(config, github.fetcher);
  assert.equal(await first.load(), null);
  await first.save(stored);
  const second = createStore(config, github.fetcher);
  await second.load();
  await first.save({ ...stored, pageText: "New baseline" });
  await assert.rejects(second.save({ ...stored, pageText: "Stale baseline" }), /branch changed/u);
  github.failUpdate();
  await assert.rejects(first.save({ ...stored, pageText: "Failed baseline" }), /HTTP 409/u);
  assert.equal((await createStore(config, github.fetcher).load())?.pageText, "New baseline");
});

test("missing or corrupted stored YAML fails instead of silently resetting the baseline", async () => {
  const github = fakeGitHub();
  const firstResource = stored.resources[0];
  assert.ok(firstResource);
  const resource = { ...firstResource, yamlTextStored: true as const };
  const state = JSON.stringify({ ...stored, resources: [resource] });
  const path = `.monitor-state/documents/spec-${createHash("sha256").update(resource.url).digest("hex")}.yaml`;
  github.seed(new Map([[".monitor-state/snapshot.json", state]]));
  await assert.rejects(createStore(config, github.fetcher).load(), /document text is missing/u);
  github.seed(new Map([[".monitor-state/snapshot.json", state], [path, "wrong text"]]));
  await assert.rejects(createStore(config, github.fetcher).load(), /does not match its hash/u);
});

test("only missing state files initialize; corrupt, incompatible and error responses fail", async () => {
  assert.equal(await createStore(config, async () => new Response(null, { status: 404 })).load(), null);
  for (const value of ["not-json", "{}", JSON.stringify({ ...stored, version: 2 }),
    JSON.stringify({ ...stored, resources: [{ ...stored.resources[0], status: 200, hash: null }] })]) {
    await assert.rejects(createStore(config, async (input) => String(input).includes("/git/ref/")
      ? Response.json({ object: { sha: "head" } }) : Response.json({
      sha: "blob-sha",
      content: Buffer.from(value).toString("base64"),
      encoding: "base64",
    })).load(),
      /Stored snapshot/u);
  }
  await assert.rejects(createStore(config, async (input) => String(input).includes("/git/ref/")
    ? Response.json({ object: { sha: "head" } }) : Response.json({ error: "ERR" })).load(),
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
  const github = fakeGitHub();
  let spec = "openapi: 3.0.0\ninfo:\n  version: 1.0.0";
  const deliveries: string[] = [];
  const fetcher: Fetch = async (input, init) => {
    const url = String(input);
    if (url.startsWith("https://api.github.com/")) return github.fetcher(input, init);
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
  assert.match(deliveries[1] ?? "", /\+   description: Deprecated endpoint removed/u);
  assert.ok(github.files().has(".monitor-state/snapshot.json"));
});
