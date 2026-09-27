import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Orca } from "../shared/contracts";
import { BROWSER_STATES } from "../shared/panel-contracts";
import {
  CvHubError,
  RestClient,
  isLoopback,
  normalizeOrigin,
  readBoundedJson,
  type Fetch,
} from "./rest-client";

/** CV Hub's public device-flow client for its own CLI tools, which every deployment ships
 *  (migration 0017_cv_git_oauth_client), so the plugin needs no per-server registration. The
 *  plugin still requests only the scopes below, not the client's full set. No secret exists. */
export const CLIENT_ID = "cv-git-cli";
/** repo:write lets the plugin publish PR reviews; offline_access yields a refresh token. */
export const REQUESTED_SCOPES = ["profile", "repo:read", "repo:write", "offline_access"];
const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";
const REFRESH_MARGIN_MS = 60_000;
const MAX_BACKOFF_S = 60;

export type Clock = {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
};
const realClock: Clock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

const profileSchema = z.object({
  kind: z.literal("oauth"),
  connectionId: z.string(),
  origin: z.string(),
  webOrigin: z.string().optional(),
  mcpUrl: z.string(),
  username: z.string(),
  userId: z.string(),
  displayName: z.string().nullable().optional(),
  scopes: z.array(z.string()),
  expired: z.boolean().optional(),
});
/** Profiles written by the PAT version of this plugin carry no `kind`. */
const legacyProfileSchema = z.object({ origin: z.string(), username: z.string() });
const tokensSchema = z.object({
  accessToken: z.string().min(1),
  refreshToken: z.string().min(1).optional(),
  expiresAt: z.number(),
});
type Profile = z.infer<typeof profileSchema>;
type Tokens = z.infer<typeof tokensSchema>;

export type BrowserState = (typeof BROWSER_STATES)[number];
export type AttemptPhase =
  | "pending"
  | "denied"
  | "expired"
  | "offline"
  | "invalid_client"
  | "error"
  | "connected";
type Attempt = {
  attemptId: string;
  generation: number;
  origin: string;
  phase: AttemptPhase;
  userCode: string;
  verificationUri: string;
  verificationUriComplete?: string;
  expiresAt: number;
  intervalS: number;
  deviceCode: string; // secret: never leaves the worker
  timer?: unknown;
  message?: string;
  /** The verification URL checked against the server's discovery metadata, or null. */
  verifiedUrl: string | null;
  browser: BrowserState;
  browserMessage?: string;
  /** Orca's browser-authorization handle. Worker-only: never sent to the panel. */
  hostAttempt?: string;
  opening?: boolean;
};
const deviceAuthorizationSchema = z.object({
  device_code: z.string().min(1),
  user_code: z.string().min(1).max(32),
  verification_uri: z.string().url(),
  verification_uri_complete: z.string().url().optional(),
  expires_in: z.number().positive(),
  interval: z.number().positive().optional(),
});
const tokenResponseSchema = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1).optional(),
  expires_in: z.number().positive().optional(),
  scope: z.string().optional(),
});
const oauthErrorSchema = z.object({
  error: z.string(),
  error_description: z.string().optional(),
  interval: z.number().optional(),
});

const UNVERIFIED =
  "Orca can’t confirm this address belongs to your CV Hub server, so it won’t open it. Enter the code there yourself only if you trust the address.";
const UNAVAILABLE =
  "This Orca build can’t open the browser for plugins (it needs the browser:authorize host, lamtuanvu/orca 75b02825). Open the address below yourself.";
/** Only http(s), HTTPS unless loopback, and no embedded credentials may reach the browser. */
export function safeBrowserUrl(value: string): string {
  const url = new URL(value);
  const okScheme =
    url.protocol === "https:" || (url.protocol === "http:" && isLoopback(url.hostname));
  if (!okScheme || url.username || url.password)
    throw new CvHubError("unsafe_url", "CV Hub returned a verification address Orca won’t open");
  return url.href;
}

export class Connection {
  private attempt: Attempt | null = null;
  private generation = 0;
  private refreshing: Promise<string> | null = null;
  private changing = false;
  constructor(
    private readonly host: Orca["host"],
    private readonly fetcher: Fetch = fetch,
    private readonly clock: Clock = realClock,
  ) {}

  // ---------- storage ----------
  private async stored(): Promise<unknown> {
    return z
      .object({ value: z.unknown() })
      .parse(await this.host.call("storage.get", { key: "connection" })).value;
  }
  async profile(): Promise<Profile | null> {
    const parsed = profileSchema.safeParse(await this.stored());
    return parsed.success ? parsed.data : null;
  }
  private async tokens(): Promise<Tokens | null> {
    const { value } = z
      .object({ value: z.string().nullable() })
      .parse(await this.host.call("secrets.get", { key: "oauth" }));
    if (!value) return null;
    try {
      return tokensSchema.parse(JSON.parse(value));
    } catch {
      return null;
    }
  }
  private async saveTokens(tokens: Tokens) {
    await this.host.call("secrets.set", { key: "oauth", value: JSON.stringify(tokens) });
  }

  // ---------- public status (safe for the panel) ----------
  private attemptView() {
    const a = this.attempt;
    if (!a) return null;
    return {
      attemptId: a.attemptId,
      origin: a.origin,
      phase: a.phase,
      userCode: a.userCode,
      // The address to copy for manual navigation: the pre-filled link when it was verified.
      verificationUri: a.verifiedUrl ?? a.verificationUri,
      expiresAt: a.expiresAt,
      message: a.message ?? null,
      browser: a.browser,
      browserMessage: a.browserMessage ?? null,
    };
  }
  async status() {
    const raw = await this.stored();
    const profile = profileSchema.safeParse(raw);
    const legacy = !profile.success ? legacyProfileSchema.safeParse(raw) : null;
    return {
      connection: profile.success
        ? {
            origin: profile.data.origin,
            webOrigin: profile.data.webOrigin ?? null,
            mcpUrl: profile.data.mcpUrl,
            username: profile.data.username,
            userId: profile.data.userId,
            displayName: profile.data.displayName ?? null,
            canWrite: profile.data.scopes.includes("repo:write"),
            expired: profile.data.expired === true,
          }
        : null,
      legacy: legacy?.success ? { origin: legacy.data.origin, username: legacy.data.username } : null,
      attempt: this.attemptView(),
    };
  }

  // ---------- OAuth form endpoints ----------
  private async form(origin: string, path: string, body: Record<string, string>) {
    let response: Response;
    try {
      response = await this.fetcher(new URL(path, origin), {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(20000),
        headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
        body: new URLSearchParams(body).toString(),
      });
    } catch {
      return { offline: true as const };
    }
    const data = response.status === 200 && path.endsWith("/revoke")
      ? {}
      : await readBoundedJson(response, 64 * 1024).catch(() => ({}));
    return { offline: false as const, ok: response.ok, status: response.status, data };
  }

  // ---------- device authorization ----------
  async start(args: unknown) {
    if (this.changing) throw new CvHubError("busy", "A connection change is already in progress");
    const origin = normalizeOrigin(z.object({ origin: z.string().max(2048) }).parse(args).origin);
    this.cancelAttempt();
    const generation = ++this.generation;
    const result = await this.form(origin, "/oauth/device/authorize", {
      client_id: CLIENT_ID,
      scope: REQUESTED_SCOPES.join(" "),
    });
    if (generation !== this.generation) throw new CvHubError("cancelled", "Sign-in was cancelled");
    if (result.offline)
      throw new CvHubError("offline", `Can’t reach ${new URL(origin).host}`);
    if (!result.ok) {
      const error = oauthErrorSchema.safeParse(result.data);
      const code = error.success ? error.data.error : "";
      if (code === "invalid_client" || code === "unauthorized_client")
        throw new CvHubError(
          "invalid_client",
          "This CV Hub server doesn’t have the sign-in client the plugin uses (cv-git-cli). Ask an administrator to check its OAuth clients.",
        );
      if (code === "invalid_scope")
        throw new CvHubError("invalid_client", "This CV Hub server doesn’t allow the plugin’s scopes");
      throw new CvHubError("server_error", `CV Hub couldn’t start sign-in (${result.status})`);
    }
    const device = deviceAuthorizationSchema.parse(result.data);
    safeBrowserUrl(device.verification_uri);
    if (device.verification_uri_complete) safeBrowserUrl(device.verification_uri_complete);
    const verifiedUrl = this.verifyDestination(origin, device);
    if (generation !== this.generation) throw new CvHubError("cancelled", "Sign-in was cancelled");
    this.attempt = {
      attemptId: randomUUID(),
      generation,
      origin,
      phase: "pending",
      userCode: device.user_code,
      verificationUri: device.verification_uri,
      verificationUriComplete: device.verification_uri_complete,
      expiresAt: this.clock.now() + device.expires_in * 1000,
      intervalS: Math.max(1, device.interval ?? 5),
      deviceCode: device.device_code,
      verifiedUrl,
      browser: verifiedUrl ? "idle" : "unverified",
      browserMessage: verifiedUrl ? undefined : UNVERIFIED,
    };
    this.schedulePoll(this.attempt);
    return this.attemptView();
  }
  /** The device response names a browser destination; accept it only when it is CV Hub's
   *  approval page (`/device`) on a host that belongs to this deployment: the API's own origin,
   *  or the web app beside an `api.` API host (api.hub.example.com → hub.example.com), which is
   *  how CV Hub is deployed. A loopback API accepts a loopback page on any port, for local
   *  development where the web app runs on its own port. */
  private verifyDestination(origin: string, device: z.infer<typeof deviceAuthorizationSchema>): string | null {
    const api = new URL(origin);
    const allowed = (u: URL) => {
      if (u.pathname !== "/device" || u.username || u.password || u.hash) return false;
      if (u.origin === api.origin) return true;
      if (isLoopback(api.hostname)) return isLoopback(u.hostname);
      return u.protocol === "https:" && u.port === "" && api.port === "" && api.hostname.startsWith("api.") && u.hostname === api.hostname.slice(4);
    };
    for (const url of [device.verification_uri_complete, device.verification_uri]) {
      if (!url) continue;
      const u = new URL(url);
      if (allowed(u)) return u.href;
    }
    return null;
  }
  private current(attempt: Attempt) {
    return this.attempt === attempt && attempt.generation === this.generation;
  }
  private schedulePoll(attempt: Attempt, delayS = attempt.intervalS) {
    attempt.timer = this.clock.setTimeout(() => void this.poll(attempt), delayS * 1000);
  }
  private finish(attempt: Attempt, phase: AttemptPhase, message?: string) {
    attempt.phase = phase;
    attempt.message = message;
    attempt.deviceCode = "";
    this.releaseHost(attempt);
  }
  /** Cancel Orca's browser handle: on completion, denial, failure, cancellation and after use. */
  private releaseHost(attempt: Attempt) {
    const id = attempt.hostAttempt;
    attempt.hostAttempt = undefined;
    if (id) void this.host.call("browser.cancelAuthorization", { attemptId: id }).catch(() => undefined);
  }
  private async poll(attempt: Attempt, backoffS = 0) {
    if (!this.current(attempt) || attempt.phase !== "pending") return;
    if (this.clock.now() >= attempt.expiresAt) return this.finish(attempt, "expired");
    const result = await this.form(attempt.origin, "/oauth/token", {
      grant_type: DEVICE_GRANT,
      device_code: attempt.deviceCode,
      client_id: CLIENT_ID,
    });
    if (!this.current(attempt) || attempt.phase !== "pending") {
      if (!result.offline && result.ok) await this.revokeIssued(attempt.origin, result.data);
      return;
    }
    if (result.offline) {
      // Bounded exponential backoff; the attempt still ends at its expiry.
      const next = Math.min(MAX_BACKOFF_S, Math.max(attempt.intervalS, (backoffS || attempt.intervalS) * 2));
      attempt.timer = this.clock.setTimeout(() => void this.poll(attempt, next), next * 1000);
      return;
    }
    if (!result.ok) {
      const error = oauthErrorSchema.safeParse(result.data);
      const code = error.success ? error.data.error : "server_error";
      if (code === "authorization_pending") return this.schedulePoll(attempt);
      if (code === "slow_down") {
        attempt.intervalS = Math.max(attempt.intervalS + 5, error.success ? error.data.interval ?? 0 : 0);
        return this.schedulePoll(attempt);
      }
      if (code === "access_denied") return this.finish(attempt, "denied");
      if (code === "expired_token") return this.finish(attempt, "expired");
      if (code === "invalid_client" || code === "unauthorized_client")
        return this.finish(attempt, "invalid_client");
      return this.finish(attempt, "error", `CV Hub returned ${code}`);
    }
    const tokens = tokenResponseSchema.safeParse(result.data);
    if (!tokens.success) return this.finish(attempt, "error", "CV Hub returned an invalid token response");
    try {
      await this.establish(attempt, tokens.data);
    } catch (error) {
      await this.revokeIssued(attempt.origin, result.data);
      if (this.current(attempt))
        this.finish(attempt, "error", error instanceof Error ? error.message : "Sign-in failed");
    }
  }
  /** Verify identity and MCP discovery with the new token before declaring sign-in complete. */
  private async establish(attempt: Attempt, token: z.infer<typeof tokenResponseSchema>) {
    const client = new RestClient(attempt.origin, token.access_token, this.fetcher);
    const [{ user }, discovery] = await Promise.all([
      client.json("/api/auth/me").then((data) =>
        z
          .object({
            user: z.object({
              id: z.string(),
              username: z.string(),
              displayName: z.string().nullable().optional(),
            }),
          })
          .parse(data),
      ),
      client
        .json("/api/mcp/connection-info")
        .then((data) =>
          z.object({ mcpUrl: z.string().url(), transport: z.literal("streamable-http") }).parse(data),
        ),
    ]);
    const mcpUrl = new URL(discovery.mcpUrl);
    if (mcpUrl.origin !== attempt.origin || mcpUrl.username || mcpUrl.password)
      throw new CvHubError("mcp_origin", "MCP discovery returned a different API origin");
    if (!this.current(attempt)) throw new CvHubError("cancelled", "Sign-in was cancelled");
    const scopes = token.scope ? token.scope.split(" ").filter(Boolean) : ["repo:read"];
    const profile: Profile = {
      kind: "oauth",
      connectionId: randomUUID(),
      origin: attempt.origin,
      ...(attempt.verifiedUrl ? { webOrigin: new URL(safeBrowserUrl(attempt.verifiedUrl)).origin } : {}),
      mcpUrl: mcpUrl.href,
      username: user.username,
      userId: user.id,
      displayName: user.displayName ?? null,
      scopes,
    };
    this.changing = true;
    try {
      await this.saveTokens({
        accessToken: token.access_token,
        refreshToken: token.refresh_token,
        expiresAt: this.clock.now() + (token.expires_in ?? 3600) * 1000,
      });
      try {
        await this.host.call("storage.set", { key: "connection", value: profile });
      } catch {
        await this.host.call("secrets.delete", { key: "oauth" });
        throw new CvHubError("storage", "Could not save the connection");
      }
      // A PAT from the previous plugin version is replaced, never reused as an OAuth token.
      await this.host.call("secrets.delete", { key: "pat" }).catch(() => undefined);
    } finally {
      this.changing = false;
    }
    this.finish(attempt, "connected");
  }
  private async revokeIssued(origin: string, data: unknown) {
    const t = tokenResponseSchema.safeParse(data);
    if (!t.success) return;
    for (const [token, hint] of [
      [t.data.refresh_token, "refresh_token"],
      [t.data.access_token, "access_token"],
    ] as const)
      if (token) await this.form(origin, "/oauth/revoke", { token, token_type_hint: hint });
  }
  private cancelAttempt() {
    if (!this.attempt) return;
    this.clock.clearTimeout(this.attempt.timer);
    this.attempt.deviceCode = "";
    this.releaseHost(this.attempt);
    this.attempt = null;
  }
  cancel(args: unknown) {
    const { attemptId } = z.object({ attemptId: z.string().optional() }).parse(args ?? {});
    if (this.attempt && (!attemptId || this.attempt.attemptId === attemptId)) {
      this.cancelAttempt();
      this.generation++;
    }
    return this.status();
  }
  /** Starts Orca's browser hand-off without waiting for it: the host shows a native
   *  confirmation that can take arbitrarily long, and worker commands time out after 30 s.
   *  The outcome is reported through status(). The panel never sees Orca's handle. */
  openVerification(args: unknown) {
    const { attemptId } = z.object({ attemptId: z.string() }).parse(args);
    const a = this.attempt;
    if (!a || a.attemptId !== attemptId || a.phase !== "pending")
      throw new CvHubError("no_attempt", "This sign-in request is no longer active");
    const view = () => ({ requested: a.opening === true, browser: a.browser, browserMessage: a.browserMessage ?? null });
    if (!a.verifiedUrl || a.opening) return view();
    a.opening = true;
    a.browser = "confirming";
    a.browserMessage = undefined;
    void this.handOff(a);
    return view();
  }
  private async handOff(a: Attempt) {
    try {
      this.releaseHost(a); // a consumed or stale handle blocks creating a new one
      const expiresIn = Math.min(900, Math.floor((a.expiresAt - this.clock.now()) / 1000));
      if (expiresIn < 1) return this.finish(a, "expired");
      const created = z
        .object({ attemptId: z.string(), expiresAt: z.number() })
        .parse(
          await this.host.call("browser.createAuthorization", {
            serverOrigin: a.origin,
            verificationUrl: a.verifiedUrl,
            expiresIn,
          }),
        );
      if (!this.current(a) || a.phase !== "pending") {
        void this.host.call("browser.cancelAuthorization", { attemptId: created.attemptId }).catch(() => undefined);
        return;
      }
      a.hostAttempt = created.attemptId;
      const result = z
        .object({ opened: z.boolean() })
        .parse(await this.host.call("browser.openAuthorization", { attemptId: created.attemptId }));
      if (!this.current(a)) return;
      a.browser = result.opened ? "opened" : "declined";
      a.browserMessage = result.opened ? undefined : "You declined opening the browser. Continue again, or open the address yourself.";
      this.releaseHost(a); // single-use: free the slot so a later retry can create a new one
    } catch (error) {
      if (!this.current(a)) return;
      const text = error instanceof Error ? error.message : "";
      if (/rate limited|already pending/i.test(text)) {
        a.browser = "rate_limited";
        a.browserMessage = "Orca allows one browser request every few seconds. Try again shortly.";
      } else if (/Authorization unavailable|Plugin unavailable/i.test(text)) {
        a.browser = "invalidated";
        a.browserMessage = "Orca reset this browser request (the plugin was refreshed or updated). Choose Continue in browser again.";
      } else if (/confirmation pending/i.test(text)) {
        a.browser = "confirming";
      } else {
        a.browser = "unavailable";
        a.browserMessage = UNAVAILABLE;
      }
      this.releaseHost(a);
    } finally {
      a.opening = false;
    }
  }

  // ---------- tokens for API calls ----------
  private async markExpired(profile: Profile) {
    if ((await this.profile())?.connectionId !== profile.connectionId) return;
    await this.host.call("secrets.delete", { key: "oauth" });
    await this.host.call("storage.set", { key: "connection", value: { ...profile, expired: true } });
  }
  private async refresh(profile: Profile, tokens: Tokens): Promise<string> {
    if (!this.refreshing)
      this.refreshing = (async () => {
        if (!tokens.refreshToken) {
          await this.markExpired(profile);
          throw new CvHubError("session_expired", "Your CV Hub session ended. Sign in again");
        }
        const result = await this.form(profile.origin, "/oauth/token", {
          grant_type: "refresh_token",
          refresh_token: tokens.refreshToken,
          client_id: CLIENT_ID,
        });
        if (result.offline) throw new CvHubError("offline", "CV Hub is unreachable or timed out");
        if (!result.ok) {
          const code = oauthErrorSchema.safeParse(result.data);
          if (code.success && (code.data.error === "invalid_grant" || code.data.error === "invalid_client")) {
            await this.markExpired(profile);
            throw new CvHubError("session_expired", "Your CV Hub session ended. Sign in again");
          }
          throw new CvHubError("server_error", `CV Hub couldn’t refresh the session (${result.status})`);
        }
        const next = tokenResponseSchema.parse(result.data);
        if ((await this.profile())?.connectionId !== profile.connectionId)
          throw new CvHubError("connection_changed", "The connection changed. Try again");
        // Rotation: the old refresh token is now spent, so persist the new one before use.
        await this.saveTokens({
          accessToken: next.access_token,
          refreshToken: next.refresh_token ?? tokens.refreshToken,
          expiresAt: this.clock.now() + (next.expires_in ?? 3600) * 1000,
        });
        return next.access_token;
      })().finally(() => {
        this.refreshing = null;
      });
    return this.refreshing;
  }
  private async accessToken(profile: Profile, force = false): Promise<string> {
    if (this.refreshing) return this.refreshing;
    const tokens = await this.tokens();
    if (!tokens) {
      await this.markExpired(profile);
      throw new CvHubError("session_expired", "Your CV Hub session ended. Sign in again");
    }
    if (force || tokens.expiresAt - REFRESH_MARGIN_MS <= this.clock.now())
      return this.refresh(profile, tokens);
    return tokens.accessToken;
  }

  async disconnect() {
    this.cancelAttempt();
    this.generation++;
    this.changing = true;
    let revoked = true;
    try {
      const profile = await this.profile();
      const tokens = await this.tokens();
      await this.host.call("storage.delete", { key: "connection" });
      await this.host.call("secrets.delete", { key: "oauth" });
      await this.host.call("secrets.delete", { key: "pat" });
      if (profile && tokens) {
        for (const [token, hint] of [
          [tokens.refreshToken, "refresh_token"],
          [tokens.accessToken, "access_token"],
        ] as const) {
          if (!token) continue;
          const result = await this.form(profile.origin, "/oauth/revoke", { token, token_type_hint: hint });
          if (result.offline || !result.ok) revoked = false;
        }
      }
    } finally {
      this.changing = false;
    }
    return { signedOut: true, revoked };
  }

  async client() {
    if (this.changing) throw new CvHubError("busy", "Connection change in progress");
    const raw = await this.stored();
    const profile = profileSchema.safeParse(raw);
    if (!profile.success) {
      if (legacyProfileSchema.safeParse(raw).success)
        throw new CvHubError("reauth_required", "Sign in with CV Hub to continue");
      throw new CvHubError("signed_out", "Sign in to CV Hub first");
    }
    const p = profile.data;
    if (p.expired) throw new CvHubError("session_expired", "Your CV Hub session ended. Sign in again");
    const token = await this.accessToken(p);
    const same = async () => (await this.profile())?.connectionId === p.connectionId && !this.changing;
    return {
      ...p,
      token,
      canWrite: p.scopes.includes("repo:write"),
      json: async (path: string, init?: RequestInit, limit?: number) => {
        if (!(await same())) throw new CvHubError("connection_changed", "The connection changed");
        let result: unknown;
        try {
          result = await new RestClient(p.origin, await this.accessToken(p), this.fetcher).json(path, init, limit);
        } catch (error) {
          // A 401 was rejected outright, so nothing was recorded; refresh once and retry reads only.
          if (!(error instanceof CvHubError) || error.code !== "unauthorized") throw error;
          const fresh = await this.accessToken(p, true);
          if (init?.method && init.method !== "GET")
            throw new CvHubError("unauthorized", "Your session was refreshed. Submit again");
          result = await new RestClient(p.origin, fresh, this.fetcher).json(path, init, limit);
        }
        if (!(await same())) throw new CvHubError("connection_changed", "The connection changed. Try again");
        return result;
      },
    };
  }
}
