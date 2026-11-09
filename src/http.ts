export type Fetch = typeof globalThis.fetch;
export type Sleep = (milliseconds: number) => Promise<void>;
export const sleep: Sleep = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

const MAX_BYTES = 15 * 1024 * 1024;
const MAX_ATTEMPTS = 3;

export interface HttpResult {
  status: number;
  headers: Headers;
  body: Buffer;
}

export function retryDelay(value: string | null, attempt: number): number {
  const seconds = value === null ? NaN : Number(value);
  const requested = Number.isFinite(seconds)
    ? seconds * 1000
    : value === null ? NaN : Date.parse(value) - Date.now();
  return Math.min(30_000, Math.max(1000, Number.isFinite(requested) ? requested : 1000 * 2 ** attempt));
}

async function readBody(response: Response): Promise<Buffer> {
  if (Number(response.headers.get("content-length")) > MAX_BYTES) {
    await response.body?.cancel();
    throw new Error("Response exceeds the 15 MiB download limit");
  }
  const chunks: Uint8Array[] = [];
  let length = 0;
  if (response.body) {
    for await (const chunk of response.body) {
      length += chunk.byteLength;
      if (length > MAX_BYTES) {
        throw new Error("Response exceeds the 15 MiB download limit");
      }
      chunks.push(chunk);
    }
  }
  return Buffer.concat(chunks);
}

export async function request(
  url: string,
  init: RequestInit,
  label: string,
  options: {
    fetch?: Fetch;
    sleep?: Sleep;
    retry?: boolean;
    acceptedStatuses?: number[];
  } = {},
): Promise<HttpResult> {
  const fetcher = options.fetch ?? globalThis.fetch;
  const pause = options.sleep ?? sleep;
  const attempts = options.retry === false ? 1 : MAX_ATTEMPTS;
  for (let attempt = 0; attempt < attempts; attempt++) {
    let response: Response;
    let body: Buffer;
    try {
      response = await fetcher(url, {
        ...init,
        signal: AbortSignal.timeout(30_000),
      });
      body = await readBody(response);
    } catch {
      if (attempt + 1 < attempts) {
        await pause(retryDelay(null, attempt));
        continue;
      }
      // Fetch errors can include credentials from webhook URLs.
      throw new Error(`${label}: request failed, timed out, or exceeded the download limit`);
    }
    if (response.ok || options.acceptedStatuses?.includes(response.status)) {
      return { status: response.status, headers: response.headers, body };
    }
    if ((response.status === 429 || response.status >= 500) && attempt + 1 < attempts) {
      await pause(retryDelay(response.headers.get("retry-after"), attempt));
      continue;
    }
    throw new Error(`${label}: HTTP ${response.status}`);
  }
  throw new Error(`${label}: retries exhausted`);
}
