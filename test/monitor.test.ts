import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { collectSnapshot, describeChanges, parsePage, runMonitor, splitMessages } from "../src/monitor.ts";
import { SOURCE_URL } from "../src/model.ts";
import type { Snapshot, StateStore } from "../src/model.ts";

const documentUrl = new URL("/media/spec.yaml", SOURCE_URL).href;
const page = (text = "Current API", extra = "") => `
  <nav>Navigation</nav>
  <div id="articlecontent">
    <div class="full-width-content"><h1>Skifteportalen</h1></div>
    <article><p>${text}</p>
      <a href="/media/spec.yaml" title="API specification">Spec</a>${extra}
      <div class="panel"><p>Deprecation information</p></div>
    </article>
  </div><footer>Footer</footer>`;

function snapshot(overrides: Partial<Snapshot> = {}): Snapshot {
  return {
    version: 1,
    sourceUrl: SOURCE_URL,
    checkedAt: "2026-11-09T07:00:00.000Z",
    pageText: "Current API",
    resources: [{
      url: documentUrl,
      label: "Spec",
      status: 200,
      hash: "a".repeat(64),
    }],
    ...overrides,
  };
}

test("parses article, collapsed panels, links and entities but not navigation or scripts", () => {
  const parsed = parsePage(page("Current &amp; future API", '<script>random()</script>'));
  assert.match(parsed.pageText, /Current & future API/u);
  assert.match(parsed.pageText, /Deprecation information/u);
  assert.match(parsed.pageText, /API specification/u);
  assert.doesNotMatch(parsed.pageText, /Navigation|Footer|random/u);
  assert.deepEqual(parsed.links, [{ url: documentUrl, label: "Spec" }]);
});

test("ignores whitespace, styling, cookie scripts and navigation changes", () => {
  const first = parsePage(page());
  const second = parsePage(page(" Current \n API ").replace("Navigation", "Other navigation")
    .replace("<article>", '<article class="new"><script>cookie()</script>'));
  assert.deepEqual(first, second);
});

test("discovers new document formats, empty CMS anchors, absolute URLs and duplicate labels", () => {
  const parsed = parsePage(page("API", `
    <a href="/media/spec.yaml#section">Other spec label</a>
    <a href="/media/old.yaml" title="Old spec"></a>
    <a href="https://example.com/guide.pdf">Guide</a>
    <a href="/media/download">Download</a>
    <a href="">Empty</a>
  `));
  assert.equal(parsed.links.length, 4);
  assert.equal(parsed.links.find((link) => link.url === documentUrl)?.label, "Spec; Other spec label");
  assert.ok(parsed.links.some((link) => link.label === "Old spec"));
});

test("fails explicitly on layout changes, missing specifications or insecure documents", () => {
  assert.throws(() => parsePage("<html>Maintenance</html>"), /layout changed/u);
  assert.throws(() => parsePage('<div id="articlecontent"><article>Hello</article></div>'),
    /no API specification links/u);
  assert.throws(() => parsePage(page("API", '<a href="http://example.com/spec.yaml">Insecure</a>')),
    /non-HTTPS/u);
});

test("captures actual document bytes and permanent unavailability without losing the run", async () => {
  const checked: string[] = [];
  const collected = await collectSnapshot(async (input) => {
    const url = String(input);
    checked.push(url);
    if (url === SOURCE_URL) return new Response(page("API", '<a href="/media/old.yaml">Old</a>'));
    if (url.endsWith("old.yaml")) return new Response("Not found", { status: 404 });
    return new Response("openapi: 3.0.0");
  });
  assert.equal(checked.length, 3);
  assert.equal(collected.resources.find((resource) => resource.url === documentUrl)?.hash,
    createHash("sha256").update("openapi: 3.0.0").digest("hex"));
  assert.equal(collected.resources.find((resource) => resource.status === 404)?.hash, null);
});

test("rejects HTML masquerading as a successful spec download", async () => {
  await assert.rejects(collectSnapshot(async (input) =>
    String(input) === SOURCE_URL ? new Response(page()) :
      new Response("<!doctype html><html>Maintenance</html>")), /HTML response/u);
});

test("detects additions, removals, same-URL changes, availability and deprecation text", () => {
  const before = snapshot();
  const after = snapshot({
    pageText: "API deprecated from November",
    resources: [
      { url: documentUrl, label: "Spec", status: 200, hash: "b".repeat(64) },
      { url: "https://example.com/new.yaml", label: "New spec", status: 200, hash: "c".repeat(64) },
    ],
  });
  const changes = describeChanges(before, after).join("\n");
  assert.match(changes, /Document content changed/u);
  assert.match(changes, /New document/u);
  assert.match(changes, /\+ API deprecated from November/u);
  assert.match(describeChanges(after, before).join("\n"), /Document link removed/u);
  const missing = snapshot({ resources: [{ url: documentUrl, label: "Spec", status: 410, hash: null }] });
  assert.match(describeChanges(before, missing).join("\n"), /200 -> 410/u);
  assert.match(describeChanges(missing, before).join("\n"), /410 -> 200/u);
});

test("timestamps alone are not changes and long article diffs are explicitly truncated", () => {
  assert.deepEqual(describeChanges(snapshot(), snapshot({ checkedAt: "2026-11-10T07:00:00.000Z" })), []);
  const changes = describeChanges(snapshot(), snapshot({
    pageText: Array.from({ length: 60 }, (_, i) => `Line ${i}`).join("\n"),
  }));
  assert.match(changes.at(-1) ?? "", /further changed lines/u);
});

test("splits oversized notifications below Discord's limit without losing content", () => {
  const text = `${"x".repeat(4000)}\n${"😀".repeat(2000)}`;
  const messages = splitMessages(text);
  assert.ok(messages.length > 1);
  assert.ok(messages.every((message) => message.length <= 2000));
  const recovered = messages.map((message) => message.replace(/^\[\d+\/\d+\] /u, "")).join("");
  assert.equal(recovered.replaceAll("\n", ""), text.replaceAll("\n", ""));
  assert.ok(messages.every((message) => !/[\uD800-\uDBFF]$/u.test(message)));
});

function memoryStore(initial: Snapshot | null): StateStore & { saved: Snapshot[] } {
  const saved: Snapshot[] = [];
  return {
    saved,
    load: async () => initial,
    save: async (value) => { saved.push(value); },
  };
}

test("first run sends initialization then persists, subsequent unchanged run stays silent", async () => {
  const current = snapshot();
  const initial = memoryStore(null);
  const delivered: string[] = [];
  assert.equal(await runMonitor(initial, async () => current, async (messages) => {
    assert.equal(initial.saved.length, 0);
    delivered.push(...messages);
  }), "initialized");
  assert.match(delivered.join("\n"), /initialized/u);
  assert.deepEqual(initial.saved, [{ ...current, lastChangedAt: null }]);
  const existing = memoryStore(current);
  assert.equal(await runMonitor(existing, async () => current, async () => {
    assert.fail("Unchanged run must not notify");
  }), "unchanged");
  assert.deepEqual(existing.saved, [{ ...current, lastChangedAt: null }]);
});

test("changes persist only after successful delivery and notification failures keep baseline", async () => {
  const store = memoryStore(snapshot());
  const changed = snapshot({ pageText: "New deprecation" });
  await assert.rejects(runMonitor(store, async () => changed, async () => {
    throw new Error("Discord unavailable");
  }), /Discord unavailable/u);
  assert.equal(store.saved.length, 0);
  assert.equal(await runMonitor(store, async () => changed, async () => {
    assert.equal(store.saved.length, 0);
  }), "changed");
  assert.deepEqual(store.saved, [{ ...changed, lastChangedAt: changed.checkedAt }]);
});

test("unchanged checks advance checkedAt and preserve the last content change date", async () => {
  const previous = snapshot({ lastChangedAt: "2026-11-08T07:07:00.000Z" });
  const current = snapshot({ checkedAt: "2026-11-10T07:07:00.000Z" });
  const store = memoryStore(previous);
  assert.equal(await runMonitor(store, async () => current, async () => {
    assert.fail("Heartbeat must not notify");
  }), "unchanged");
  assert.deepEqual(store.saved, [{ ...current, lastChangedAt: previous.lastChangedAt }]);
});

test("detected changes replace lastChangedAt only after notification succeeds", async () => {
  const store = memoryStore(snapshot({ lastChangedAt: "2026-11-08T07:07:00.000Z" }));
  const current = snapshot({
    checkedAt: "2026-11-10T07:07:00.000Z",
    pageText: "New release",
  });
  assert.equal(await runMonitor(store, async () => current, async () => {
    assert.equal(store.saved.length, 0);
  }), "changed");
  assert.deepEqual(store.saved, [{ ...current, lastChangedAt: current.checkedAt }]);
});

test("failed heartbeat writes fail the run without sending a change notification", async () => {
  await assert.rejects(runMonitor({
    load: async () => snapshot(),
    save: async () => { throw new Error("Heartbeat write failed"); },
  }, async () => snapshot({ checkedAt: "2026-11-10T07:07:00.000Z" }),
  async () => { assert.fail("Unchanged run must not notify"); }), /Heartbeat write failed/u);
});

test("collection/storage failures do not produce success-shaped results or notifications", async () => {
  const store = memoryStore(snapshot());
  await assert.rejects(runMonitor(store, async () => {
    throw new Error("Source unavailable");
  }, async () => { assert.fail("Must not send success notification"); }), /Source unavailable/u);
  assert.equal(store.saved.length, 0);
  await assert.rejects(runMonitor({
    load: async () => { throw new Error("Storage unavailable"); },
    save: async () => { assert.fail("Must not save"); },
  }, async () => { assert.fail("Must not collect"); }, async () => {}), /Storage unavailable/u);
});

test("failed first-run notification does not silently initialize", async () => {
  const store = memoryStore(null);
  await assert.rejects(runMonitor(store, async () => snapshot(), async () => {
    throw new Error("No webhook");
  }), /No webhook/u);
  assert.equal(store.saved.length, 0);
});

test("first run reports already unavailable documents", async () => {
  const unavailable = snapshot({
    resources: [{ url: documentUrl, label: "Spec", status: 404, hash: null }],
  });
  const messages: string[] = [];
  await runMonitor(memoryStore(null), async () => unavailable, async (parts) => {
    messages.push(...parts);
  });
  assert.match(messages.join("\n"), /Already unavailable \(HTTP 404\)/u);
});

test("snapshot write failures surface even after successful notification delivery", async () => {
  let delivered = false;
  await assert.rejects(runMonitor({
    load: async () => snapshot(),
    save: async () => { throw new Error("Write failed"); },
  }, async () => snapshot({ pageText: "New release" }), async () => {
    delivered = true;
  }), /Write failed/u);
  assert.equal(delivered, true);
});
