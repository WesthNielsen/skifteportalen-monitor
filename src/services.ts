import { z } from "zod";
import { request, retryDelay, sleep } from "./http.ts";
import type { Fetch, Sleep } from "./http.ts";
import { snapshotSchema } from "./model.ts";
import type { Notify, Snapshot, StateStore } from "./model.ts";

export interface Config {
  webhookUrl: string;
  githubRepository: string;
  githubToken: string;
}

const STATE_VARIABLE = "SKIFTEPORTAL_MONITOR_SNAPSHOT";
const MAX_VARIABLE_BYTES = 48 * 1024;

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
  if (!webhook.success || !repository.success || !env.MONITOR_GITHUB_TOKEN?.trim()) {
    throw new Error("Set DISCORD_WEBHOOK_URL, GITHUB_REPOSITORY, and MONITOR_GITHUB_TOKEN");
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
  };
}

export function createStore(config: Config, fetcher: Fetch = globalThis.fetch): StateStore {
  const variablesUrl =
    `https://api.github.com/repos/${config.githubRepository}/actions/variables`;
  const variableUrl = `${variablesUrl}/${STATE_VARIABLE}`;

  async function send(url: string, method: "GET" | "PATCH" | "POST", body?: string) {
    return request(url, {
      method,
      headers: {
        Authorization: `Bearer ${config.githubToken}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(body === undefined ? {} : { body }),
    }, "GitHub Actions variable", {
      fetch: fetcher,
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

  return {
    async load() {
      const response = await send(variableUrl, "GET");
      if (response.status === 404) return null;
      let raw: unknown;
      try {
        raw = JSON.parse(response.body.toString("utf8"));
      } catch {
        throw new Error("GitHub returned an invalid Actions variable response");
      }
      const variable = z.object({ value: z.string() }).safeParse(raw);
      if (!variable.success) throw new Error("GitHub returned an invalid Actions variable response");
      return variable.data.value ? parseSnapshot(variable.data.value) : null;
    },
    async save(snapshot: Snapshot) {
      const value = JSON.stringify(snapshot);
      if (Buffer.byteLength(value, "utf8") > MAX_VARIABLE_BYTES) {
        throw new Error("Monitor snapshot exceeds GitHub's 48 KB Actions variable limit");
      }
      const response = await send(variableUrl, "PATCH", JSON.stringify({ value }));
      if (response.status === 404) {
        const created = await send(variablesUrl, "POST", JSON.stringify({
          name: STATE_VARIABLE,
          value,
        }));
        if (created.status !== 201) {
          throw new Error("GitHub did not acknowledge the Actions variable creation");
        }
      } else if (response.status !== 204) {
        throw new Error("GitHub did not acknowledge the Actions variable update");
      }
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
