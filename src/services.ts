import { createHash } from "node:crypto";
import { z } from "zod";
import { request, retryDelay, sleep } from "./http.ts";
import type { Fetch, Sleep } from "./http.ts";
import { snapshotSchema } from "./model.ts";
import type { Notify, Snapshot, StateStore } from "./model.ts";

export interface Config {
  webhookUrl: string;
  githubRepository: string;
  githubToken: string;
  baseSha: string;
}

const STATE_BRANCH = "monitor-state";
const STATE_PATH = ".monitor-state/snapshot.json";
const MAX_SNAPSHOT_BYTES = 900 * 1024;
const MAX_DOCUMENT_TEXT_BYTES = 15 * 1024 * 1024;

function documentPath(url: string, type: "pdf" | "yaml"): string {
  const id = createHash("sha256").update(url).digest("hex");
  const name = (new URL(url).pathname.split("/").pop() || "document")
    .replace(/\.(pdf|ya?ml)$/iu, "").replace(/[^a-z0-9._-]/giu, "_").slice(0, 100) || "document";
  return `.monitor-state/documents/${name}-${id}.${type === "pdf" ? "pdf.txt" : "yaml"}`;
}

function githubErrorDetails(body: Buffer, token: string): string | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(body.toString("utf8"));
  } catch {
    return undefined;
  }
  const parsed = z.object({ message: z.string() }).safeParse(raw);
  if (!parsed.success) return undefined;
  const message = parsed.data.message
    .replaceAll(token, "[REDACTED]")
    .replace(/[\r\n\t]+/gu, " ")
    .slice(0, 500);
  return message ? message : undefined;
}

export function readConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const webhook = z.url().safeParse(env.DISCORD_WEBHOOK_URL);
  const repository = z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u)
    .safeParse(env.GITHUB_REPOSITORY);
  const baseSha = z.string().regex(/^[a-f0-9]{40}$/iu).safeParse(env.MONITOR_BASE_SHA);
  if (!webhook.success || !repository.success || !baseSha.success || !env.MONITOR_GITHUB_TOKEN?.trim()) {
    throw new Error("Set DISCORD_WEBHOOK_URL, GITHUB_REPOSITORY, MONITOR_BASE_SHA, and MONITOR_GITHUB_TOKEN");
  }
  const webhookUrl = new URL(webhook.data);
  if (webhookUrl.protocol !== "https:" ||
    !["discord.com", "discordapp.com"].includes(webhookUrl.hostname) ||
    !/^\/api\/webhooks\/\d+\/[^/]+$/u.test(webhookUrl.pathname) ||
    webhookUrl.username || webhookUrl.password || webhookUrl.port) {
    throw new Error("DISCORD_WEBHOOK_URL must be an HTTPS Discord webhook URL");
  }
  return {
    webhookUrl: webhook.data,
    githubRepository: repository.data,
    githubToken: env.MONITOR_GITHUB_TOKEN.trim(),
    baseSha: baseSha.data,
  };
}

export function createStore(config: Config, fetcher: Fetch = globalThis.fetch): StateStore {
  const apiUrl = `https://api.github.com/repos/${config.githubRepository}`;
  const stateUrl = `${apiUrl}/contents/${STATE_PATH}`;
  const stateRefUrl = `${apiUrl}/git/ref/heads/${STATE_BRANCH}`;
  let loadedHead: string | null = null;
  let loadedFiles = new Map<string, string>();

  async function send(
    url: string,
    method: "GET" | "POST" | "PATCH",
    body?: string,
    raw = false,
  ) {
    return request(url, {
      method,
      headers: {
        Authorization: "Bearer " + config.githubToken,
        Accept: raw ? "application/vnd.github.raw+json" : "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(body === undefined ? {} : { body }),
    }, "GitHub state branch", {
      fetch: fetcher,
      retry: method === "GET",
      acceptedStatuses: [404],
      errorDetails: (_status, responseBody) => githubErrorDetails(responseBody, config.githubToken),
    });
  }

  function parseSnapshot(value: string): Snapshot {
    let raw: unknown;
    try {
      raw = JSON.parse(value);
    } catch {
      throw new Error("Stored snapshot is not valid JSON; baseline was not reset");
    }
    const parsed = snapshotSchema.safeParse(raw);
    if (!parsed.success) {
      throw new Error("Stored snapshot has an incompatible or corrupt format; baseline was not reset");
    }
    return parsed.data;
  }

  async function getStateFile(ref: string) {
    const response = await send(`${stateUrl}?ref=${ref}`, "GET");
    if (response.status === 404) return null;
    let raw: unknown;
    try {
      raw = JSON.parse(response.body.toString("utf8"));
    } catch {
      throw new Error("GitHub returned an invalid state file response");
    }
    const file = z.object({
      sha: z.string().min(1),
      content: z.string(),
      encoding: z.literal("base64"),
    }).safeParse(raw);
    if (!file.success) throw new Error("GitHub returned an invalid state file response");
    return file.data;
  }

  function parseSha(body: Buffer, description: string): string {
    let raw: unknown;
    try {
      raw = JSON.parse(body.toString("utf8"));
    } catch {
      throw new Error(`GitHub returned an invalid ${description} response`);
    }
    const parsed = z.object({ sha: z.string().min(1) }).safeParse(raw);
    if (!parsed.success) throw new Error(`GitHub returned an invalid ${description} response`);
    return parsed.data.sha;
  }

  async function getHead(): Promise<string | null> {
    const response = await send(stateRefUrl, "GET");
    if (response.status === 404) return null;
    let raw: unknown;
    try {
      raw = JSON.parse(response.body.toString("utf8"));
    } catch {
      throw new Error("GitHub returned an invalid state branch response");
    }
    const parsed = z.object({ object: z.object({ sha: z.string().min(1) }) }).safeParse(raw);
    if (!parsed.success) throw new Error("GitHub returned an invalid state branch response");
    return parsed.data.object.sha;
  }

  return {
    async load() {
      loadedFiles = new Map();
      loadedHead = await getHead();
      if (!loadedHead) return null;
      const file = await getStateFile(loadedHead);
      if (!file) return null;
      const value = Buffer.from(file.content.replace(/\s/gu, ""), "base64").toString("utf8");
      const snapshot = parseSnapshot(value);
      const resources: Snapshot["resources"] = [];
      for (const { pdfTextStored, yamlTextStored, ...resource } of snapshot.resources) {
        let pdfText = resource.pdfText;
        let yamlText = resource.yamlText;
        for (const type of ["pdf", "yaml"] as const) {
          if (!(type === "pdf" ? pdfTextStored : yamlTextStored)) continue;
          const path = documentPath(resource.url, type);
          const response = await send(`${apiUrl}/contents/${path}?ref=${loadedHead}`, "GET", undefined, true);
          if (response.status !== 200) throw new Error(`Stored document text is missing: ${path}`);
          if (type === "yaml" && createHash("sha256").update(response.body).digest("hex") !== resource.hash) {
            throw new Error(`Stored YAML text does not match its hash: ${path}`);
          }
          let text: string;
          try {
            text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(response.body);
          } catch {
            throw new Error(`Stored document text is not valid UTF-8: ${path}`);
          }
          loadedFiles.set(path, text);
          if (type === "pdf") pdfText = text;
          else yamlText = text;
        }
        resources.push({
          ...resource,
          ...(pdfText === undefined ? {} : { pdfText }),
          ...(yamlText === undefined ? {} : { yamlText }),
        });
      }
      return { ...snapshot, resources };
    },
    async save(snapshot: Snapshot) {
      const files = new Map<string, string>();
      const resources = snapshot.resources.map(({ pdfText, yamlText, pdfTextStored: _pdfStored,
        yamlTextStored: _yamlStored, ...resource }) => {
        if (pdfText !== undefined) files.set(documentPath(resource.url, "pdf"), pdfText);
        if (yamlText !== undefined) {
          if (createHash("sha256").update(yamlText, "utf8").digest("hex") !== resource.hash) {
            throw new Error(`YAML text does not match the document hash: ${resource.url}`);
          }
          files.set(documentPath(resource.url, "yaml"), yamlText);
        }
        return {
          ...resource,
          ...(pdfText === undefined ? {} : { pdfTextStored: true as const }),
          ...(yamlText === undefined ? {} : { yamlTextStored: true as const }),
        };
      });
      const value = JSON.stringify({ ...snapshot, resources });
      if (Buffer.byteLength(value, "utf8") > MAX_SNAPSHOT_BYTES) {
        throw new Error("Monitor snapshot exceeds the GitHub contents API file size limit");
      }
      for (const [path, text] of files) {
        if (Buffer.byteLength(text, "utf8") > MAX_DOCUMENT_TEXT_BYTES) {
          throw new Error(`Document text exceeds the 15 MiB storage limit: ${path}`);
        }
      }
      let head = await getHead();
      if (head !== loadedHead) throw new Error("State branch changed since it was loaded; baseline was not advanced");
      if (!head) {
        const created = await send(`${apiUrl}/git/refs`, "POST", JSON.stringify({
          ref: `refs/heads/${STATE_BRANCH}`,
          sha: config.baseSha,
        }));
        if (created.status !== 201) throw new Error("GitHub did not acknowledge the state branch creation");
        head = config.baseSha;
      }
      const commit = await send(`${apiUrl}/git/commits/${head}`, "GET");
      let commitData: unknown;
      try {
        commitData = JSON.parse(commit.body.toString("utf8"));
      } catch {
        throw new Error("GitHub returned an invalid state commit response");
      }
      const commitParsed = z.object({ tree: z.object({ sha: z.string().min(1) }) }).safeParse(commitData);
      if (!commitParsed.success) throw new Error("GitHub returned an invalid state commit response");
      const tree = [
        { path: STATE_PATH, mode: "100644", type: "blob", content: value },
        ...[...files].filter(([path, text]) => loadedFiles.get(path) !== text)
          .map(([path, content]) => ({ path, mode: "100644", type: "blob", content })),
        ...[...loadedFiles.keys()].filter((path) => !files.has(path))
          .map((path) => ({ path, mode: "100644", type: "blob", sha: null })),
      ];
      const createdTree = await send(`${apiUrl}/git/trees`, "POST", JSON.stringify({
        base_tree: commitParsed.data.tree.sha,
        tree,
      }));
      if (createdTree.status !== 201) throw new Error("GitHub did not acknowledge the state tree creation");
      const treeSha = parseSha(createdTree.body, "state tree");
      const createdCommit = await send(`${apiUrl}/git/commits`, "POST", JSON.stringify({
        message: `Update monitor baseline (${snapshot.checkedAt})`,
        tree: treeSha,
        parents: [head],
      }));
      if (createdCommit.status !== 201) throw new Error("GitHub did not acknowledge the state commit creation");
      const commitSha = parseSha(createdCommit.body, "state commit");
      const updated = await send(`${apiUrl}/git/refs/heads/${STATE_BRANCH}`, "PATCH", JSON.stringify({
        sha: commitSha,
        force: false,
      }));
      if (updated.status !== 200) throw new Error("GitHub did not acknowledge the state branch update");
      loadedHead = commitSha;
      loadedFiles = files;
    },
  };
}

export function createNotifier(
  webhookUrl: string,
  fetcher: Fetch = globalThis.fetch,
  pause: Sleep = sleep,
): Notify {
  const url = new URL(webhookUrl);
  url.searchParams.set("wait", "true");
  return async (messages) => {
    for (const content of messages) {
      if (!content || content.length > 2000) {
        throw new Error("Discord message must contain between 1 and 2000 characters");
      }
      for (let attempt = 0; attempt < 3; attempt++) {
        const response = await request(url.href, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            content,
            allowed_mentions: { parse: [] },
            flags: 4,
          }),
        }, "Discord", { fetch: fetcher, retry: false, acceptedStatuses: [429] });
        if (response.status !== 429) break;
        if (attempt === 2) throw new Error("Discord rate limit persisted after three attempts");
        await pause(retryDelay(response.headers.get("retry-after"), attempt));
      }
    }
  };
}
