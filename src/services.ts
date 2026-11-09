import { z } from "zod";
import { request, retryDelay, sleep } from "./http.ts";
import type { Fetch, Sleep } from "./http.ts";
import { snapshotSchema } from "./model.ts";
import type { Notify, Snapshot, StateStore } from "./model.ts";

export interface Config {
  webhookUrl: string;
  redisUrl: string;
  redisToken: string;
  stateKey: string;
}

export function readConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const webhook = z.url().safeParse(env.DISCORD_WEBHOOK_URL);
  const redis = z.url().safeParse(env.UPSTASH_REDIS_REST_URL);
  if (!webhook.success || !redis.success || !env.UPSTASH_REDIS_REST_TOKEN?.trim()) {
    throw new Error("Set DISCORD_WEBHOOK_URL, UPSTASH_REDIS_REST_URL, and UPSTASH_REDIS_REST_TOKEN");
  }
  const webhookUrl = new URL(webhook.data);
  if (webhookUrl.protocol !== "https:" ||
    !["discord.com", "discordapp.com"].includes(webhookUrl.hostname) ||
    !/^\/api\/webhooks\/\d+\/[^/]+$/u.test(webhookUrl.pathname) ||
    webhookUrl.username || webhookUrl.password || webhookUrl.port) {
    throw new Error("DISCORD_WEBHOOK_URL must be an HTTPS Discord webhook URL");
  }
  const redisUrl = new URL(redis.data);
  if (redisUrl.protocol !== "https:" || !redisUrl.hostname.endsWith(".upstash.io") ||
    redisUrl.username || redisUrl.password || redisUrl.port ||
    redisUrl.pathname !== "/" || redisUrl.search || redisUrl.hash) {
    throw new Error("UPSTASH_REDIS_REST_URL must be an HTTPS Upstash REST origin");
  }
  const stateKey = env.STATE_KEY ?? "skifteportalen:monitor:v1";
  if (!stateKey.trim()) throw new Error("STATE_KEY must not be empty");
  return {
    webhookUrl: webhook.data,
    redisUrl: redisUrl.origin,
    redisToken: env.UPSTASH_REDIS_REST_TOKEN.trim(),
    stateKey,
  };
}

export function createStore(config: Config, fetcher: Fetch = globalThis.fetch): StateStore {
  async function command(args: string[]): Promise<string | null> {
    const response = await request(config.redisUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.redisToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(args),
    }, "Upstash", { fetch: fetcher });
    let value: unknown;
    try {
      value = JSON.parse(response.body.toString("utf8"));
    } catch {
      throw new Error("Upstash returned invalid JSON");
    }
    const parsed = z.object({ result: z.string().nullable() }).safeParse(value);
    if (!parsed.success) throw new Error("Upstash command failed or returned an invalid response");
    return parsed.data.result;
  }
  return {
    async load() {
      const value = await command(["GET", config.stateKey]);
      if (value === null) return null;
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
    },
    async save(snapshot: Snapshot) {
      const result = await command(["SET", config.stateKey, JSON.stringify(snapshot)]);
      if (result !== "OK") throw new Error("Upstash did not acknowledge the snapshot write");
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
