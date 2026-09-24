export type Fetch = (url: string | URL | Request, init?: RequestInit) => Promise<Response>;
export function isLoopback(hostname: string) {
  return ["localhost", "127.0.0.1", "[::1]"].includes(hostname);
}
/** Errors crossing the panel bridge keep a stable code. The bridge only carries the message,
 *  so the code travels as a `[code]` prefix that the panel parses (panel/errors.ts). */
export class CvHubError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status?: number,
  ) {
    super(`[${code}] ${message}`);
  }
}
export function normalizeOrigin(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new CvHubError("invalid_origin", "Enter the CV Hub API origin, such as https://api.example.com");
  }
  if (
    (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopback(url.hostname))) ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  )
    throw new CvHubError(
      "invalid_origin",
      "Use an HTTPS API origin, or HTTP localhost for development",
    );
  return url.origin;
}
export async function readBoundedJson(response: Response, maxBytes: number): Promise<unknown> {
  if (Number(response.headers.get("content-length")) > maxBytes) {
    await response.body?.cancel();
    throw new CvHubError("too_large", "Response exceeds the size limit");
  }
  const reader = response.body?.getReader();
  if (!reader) throw new CvHubError("invalid_response", "Empty API response");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > maxBytes) throw new CvHubError("too_large", "Response exceeds the size limit");
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new CvHubError("invalid_response", "CV Hub returned an invalid response");
  }
}
export class RestClient {
  readonly origin: string;
  constructor(
    origin: string,
    private readonly token: string,
    private readonly fetcher: Fetch = fetch,
  ) {
    this.origin = normalizeOrigin(origin);
  }
  async json(path: string, init: RequestInit = {}, maxBytes = 2 * 1024 * 1024): Promise<unknown> {
    if (!path.startsWith("/") || path.startsWith("//")) throw new Error("Invalid API path");
    const url = new URL(path, this.origin);
    if (url.origin !== this.origin) throw new Error("Invalid API origin");
    let response: Response;
    try {
      response = await this.fetcher(url, {
        ...init,
        redirect: "error",
        signal: init.signal
          ? AbortSignal.any([init.signal, AbortSignal.timeout(20000)])
          : AbortSignal.timeout(20000),
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.token}` },
      });
    } catch {
      throw init.method === "POST"
        ? new CvHubError(
            "outcome_unknown",
            "Submission status unknown. Reload reviews before trying again.",
          )
        : new CvHubError("offline", "CV Hub is unreachable or timed out");
    }
    if (!response.ok) {
      await response.body?.cancel();
      const status = response.status;
      if (status === 401)
        throw new CvHubError("unauthorized", "CV Hub rejected the sign-in. Sign in again", status);
      if (status === 403)
        throw new CvHubError("forbidden", "This account cannot perform that action", status);
      if (status === 404) throw new CvHubError("not_found", "Not found on CV Hub", status);
      if (status === 409)
        throw new CvHubError(
          "stale_revision",
          "The PR changed. Open and review its latest changes before submitting",
          status,
        );
      if (status === 429)
        throw new CvHubError(
          "rate_limited",
          "CV Hub rate limit reached. Wait before trying again",
          status,
        );
      throw new CvHubError("server_error", `CV Hub request failed (${status})`, status);
    }
    return readBoundedJson(response, maxBytes);
  }
}
