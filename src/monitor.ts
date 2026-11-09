import { createHash } from "node:crypto";
import { load } from "cheerio";
import { diffLines } from "diff";
import { request } from "./http.ts";
import type { Fetch } from "./http.ts";
import { SOURCE_URL } from "./model.ts";
import type { Notify, Resource, Snapshot, StateStore } from "./model.ts";

const normalize = (text: string): string => text.replace(/\s+/gu, " ").trim();
const hash = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");

export function parsePage(html: string): {
  pageText: string;
  links: { url: string; label: string }[];
} {
  const $ = load(html);
  const article = $("#articlecontent article");
  if (article.length !== 1) {
    throw new Error("Source page layout changed: expected one #articlecontent article");
  }
  article.find("script, style, noscript, svg").remove();
  article.find("*").addBack().contents().each((_, node) => {
    if (node.type === "text") node.data = node.data.replace(/\s+/gu, " ");
  });
  const links = new Map<string, { url: string; label: string }>();
  article.find("a[href]").each((_, element) => {
    const anchor = $(element);
    const href = anchor.attr("href")?.trim();
    if (!href) return;
    let url: URL;
    try {
      url = new URL(href, SOURCE_URL);
    } catch {
      throw new Error("Source article contains an invalid link");
    }
    const label = normalize(anchor.text() || anchor.attr("title") || url.pathname);
    const title = normalize(anchor.attr("title") ?? "");
    anchor.replaceWith($("<span>").text(` ${normalize(anchor.text())} [${title} | ${url.href}] `));
    const downloadable = url.pathname.includes("/media/") ||
      /\.(ya?ml|json|pdf|zip|docx?|xlsx?|txt|xml)$/iu.test(url.pathname);
    if (url.protocol === "https:" && downloadable) {
      url.hash = "";
      const previous = links.get(url.href);
      links.set(url.href, {
        url: url.href,
        label: previous && previous.label !== label ? `${previous.label}; ${label}` : label,
      });
    } else if (downloadable) {
      throw new Error("Source article contains a non-HTTPS document link");
    }
  });
  article.find("br").replaceWith("\n");
  article.find("p, li, h1, h2, h3, h4, h5, h6, div, section, ul, ol, table, tr")
    .each((_, element) => {
      $(element).prepend("\n").append("\n");
    });
  const pageText = [
    normalize($("#articlecontent > .full-width-content h1").text()),
    ...article.text().split(/\r?\n/u).map(normalize),
  ].filter(Boolean).join("\n");
  if (!pageText || ![...links.keys()].some((url) => /\.(ya?ml|json)$/iu.test(new URL(url).pathname))) {
    throw new Error("Source page contains no API specification links; refusing to replace the baseline");
  }
  return { pageText, links: [...links.values()].sort((a, b) => a.url.localeCompare(b.url)) };
}

export async function collectSnapshot(fetcher: Fetch = globalThis.fetch): Promise<Snapshot> {
  const page = await request(SOURCE_URL, {}, "Skifteportalen page", { fetch: fetcher });
  const parsed = parsePage(page.body.toString("utf8"));
  const resources: Resource[] = [];
  for (const link of parsed.links) {
    const result = await request(link.url, {}, `Document ${link.url}`, {
      fetch: fetcher,
      acceptedStatuses: [404, 410],
    });
    if (result.status !== 200 && result.status !== 404 && result.status !== 410) {
      throw new Error(`Document ${link.url}: unexpected HTTP ${result.status}`);
    }
    if (result.status === 200 && (
      result.body.length === 0 ||
      /text\/html/iu.test(result.headers.get("content-type") ?? "") ||
      /^\s*(<!doctype html|<html)/iu.test(result.body.toString("utf8", 0, 256))
    )) {
      throw new Error(`Document ${link.url}: empty or HTML response instead of a document`);
    }
    resources.push({
      ...link,
      status: result.status,
      hash: result.status === 200 ? hash(result.body) : null,
    });
  }
  return {
    version: 1,
    sourceUrl: SOURCE_URL,
    checkedAt: new Date().toISOString(),
    pageText: parsed.pageText,
    resources,
  };
}

export function describeChanges(previous: Snapshot, current: Snapshot): string[] {
  const changes: string[] = [];
  const before = new Map(previous.resources.map((resource) => [resource.url, resource]));
  const after = new Map(current.resources.map((resource) => [resource.url, resource]));
  for (const resource of current.resources) {
    const old = before.get(resource.url);
    const detail = `${resource.label}\n<${resource.url}>`;
    if (!old) {
      changes.push(`New document (HTTP ${resource.status}): ${detail}`);
    } else if (old.status !== resource.status) {
      changes.push(`Document availability changed (${old.status} -> ${resource.status}): ${detail}`);
    } else if (old.hash !== resource.hash) {
      changes.push(`Document content changed: ${detail}`);
    }
  }
  for (const resource of previous.resources) {
    if (!after.has(resource.url)) {
      changes.push(`Document link removed: ${resource.label}\n<${resource.url}>`);
    }
  }
  if (previous.pageText !== current.pageText) {
    changes.push("Article updated (includes announcements, deprecations, dates, and links).");
    const excerpts = diffLines(`${previous.pageText}\n`, `${current.pageText}\n`)
      .filter((part) => part.added || part.removed)
      .flatMap((part) => part.value.trim().split("\n").map((line) =>
        `${part.added ? "+" : "-"} ${line}`,
      ));
    changes.push(...excerpts.slice(0, 24).map((line) =>
      line.length > 700 ? `${line.slice(0, 697)}...` : line,
    ));
    if (excerpts.length > 24) {
      changes.push(`... ${excerpts.length - 24} further changed lines. See the source page.`);
    }
  }
  return changes;
}

export function splitMessages(text: string): string[] {
  const chunks: string[] = [];
  while (text.length > 1800) {
    let end = text.lastIndexOf("\n", 1800);
    if (end < 900) end = 1800;
    const lastCodeUnit = text.charCodeAt(end - 1);
    if (lastCodeUnit >= 0xd800 && lastCodeUnit <= 0xdbff) end--;
    chunks.push(text.slice(0, end));
    text = text.slice(end).replace(/^\n/u, "");
  }
  if (text) chunks.push(text);
  return chunks.map((chunk, index) => `[${index + 1}/${chunks.length}] ${chunk}`);
}

export async function runMonitor(
  store: StateStore,
  collect: () => Promise<Snapshot>,
  notify: Notify,
): Promise<"initialized" | "changed" | "unchanged"> {
  const previous = await store.load();
  const current = await collect();
  if (!previous) {
    const unavailable = current.resources.filter((resource) => resource.status !== 200);
    const warnings = unavailable.map((resource) =>
      `Already unavailable (HTTP ${resource.status}): ${resource.label}\n<${resource.url}>`,
    );
    await notify(splitMessages([
      "Skifteportalen monitor initialized.",
      `Watching the article and ${current.resources.length} linked documents. Daily at 07:00 UTC.`,
      `<${SOURCE_URL}>`,
      ...warnings,
    ].join("\n\n")));
    await store.save(current);
    return "initialized";
  }
  const changes = describeChanges(previous, current);
  if (changes.length === 0) return "unchanged";
  await notify(splitMessages([
    "Skifteportalen update detected",
    `Compared with ${previous.checkedAt}`,
    `<${SOURCE_URL}>`,
    ...changes,
  ].join("\n\n")));
  // Only advance after every notification succeeds, so failures are retried next run.
  await store.save(current);
  return "changed";
}
