import { describe, expect, it } from "vitest";
import { CLIENT_ID, Connection, safeBrowserUrl, type Clock } from "./connection";
import type { Orca } from "../shared/contracts";

type BrowserHost = {
  create?: (args: unknown) => unknown;
  open?: (args: { attemptId: string }) => Promise<unknown> | unknown;
};
function hostFixture(browser: BrowserHost = {}) {
  const values = new Map<string, unknown>();
  const calls: Array<{ method: string; args: unknown }> = [];
  let hostSeq = 0;
  const live = new Set<string>();
  const host: Orca["host"] = {
    call: async (method, raw) => {
      calls.push({ method, args: raw });
      if (method === "browser.createAuthorization") {
        if (browser.create) return browser.create(raw);
        if (live.size) throw new Error("Authorization already pending or rate limited");
        const attemptId = `00000000-0000-4000-8000-00000000000${++hostSeq}`;
        live.add(attemptId);
        return { attemptId, expiresAt: Date.now() + 60000 };
      }
      if (method === "browser.openAuthorization")
        return browser.open ? browser.open(raw as { attemptId: string }) : { opened: true };
      if (method === "browser.cancelAuthorization") {
        live.delete((raw as { attemptId: string }).attemptId);
        return { ok: true };
      }
      const args = raw as { key: string; value?: unknown };
      const key = method.split(".")[0] + ":" + args.key;
      if (method.endsWith(".get")) return { value: values.get(key) ?? null };
      if (method.endsWith(".set")) values.set(key, args.value);
      else values.delete(key);
      return { ok: true };
    },
  };
  return { values, calls, host };
}
const settle = async () => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
};
function clockFixture() {
  let now = 1_000_000;
  let timers: Array<{ at: number; fn: () => void; id: number }> = [];
  let seq = 0;
  const clock: Clock = {
    now: () => now,
    setTimeout: (fn, ms) => {
      const id = ++seq;
      timers.push({ at: now + ms, fn, id });
      return id;
    },
    clearTimeout: (id) => {
      timers = timers.filter((t) => t.id !== id);
    },
  };
  /** Advance time, running due timers and letting their async work settle. */
  const advance = async (ms: number) => {
    now += ms;
    for (;;) {
      const due = timers.filter((t) => t.at <= now).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      timers = timers.filter((t) => t !== due);
      due.fn();
      await settle();
    }
  };
  return { clock, advance, setNow: (v: number) => (now = v) };
}
type Route = (body: URLSearchParams) => Response | Promise<Response>;
function server(routes: Record<string, Route>) {
  const log: Array<{ path: string; body: URLSearchParams; auth?: string }> = [];
  const fetcher = async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const body = new URLSearchParams(typeof init?.body === "string" ? init.body : "");
    const auth = (init?.headers as Record<string, string> | undefined)?.Authorization;
    log.push({ path: url.pathname, body, auth });
    const route = routes[url.pathname];
    if (!route) return new Response("not found", { status: 404 });
    return route(body);
  };
  return { fetcher, log };
}
const deviceOk = () =>
  Response.json({
    device_code: "DEVICE-SECRET",
    user_code: "WDJB-MJHT",
    verification_uri: "http://localhost:5174/device",
    verification_uri_complete: "http://localhost:5174/device?code=WDJB-MJHT",
    expires_in: 900,
    interval: 5,
  });
const identity: Record<string, Route> = {
  "/api/auth/me": () =>
    Response.json({ user: { id: "u1", username: "mara", displayName: "Mara O" } }),
  "/api/mcp/connection-info": () =>
    Response.json({ mcpUrl: "http://localhost:3001/mcp", transport: "streamable-http" }),
};
const ORIGIN = "http://localhost:3001";
/** The API's RFC 8414 metadata naming its web app's approval page (apps/api/src/app.ts). */
const discovery = (verification = "http://localhost:5174/device"): Record<string, Route> => ({
  "/.well-known/oauth-authorization-server": () =>
    Response.json({ device_authorization_endpoint: `${ORIGIN}/oauth/device/authorize`, cv_hub_device_verification_uri: verification }),
});
const FULL = "profile repo:read repo:write offline_access";

describe("OAuth device sign-in", () => {
  it("polls through pending and slow_down, then keeps tokens only in the vault", async () => {
    const { host, values } = hostFixture();
    const { clock, advance } = clockFixture();
    const answers = ["authorization_pending", "slow_down", "ok"];
    const s = server({
      "/oauth/device/authorize": (body) => {
        expect(body.get("client_id")).toBe(CLIENT_ID);
        expect(body.get("scope")).toBe(FULL);
        return deviceOk();
      },
      "/oauth/token": (body) => {
        expect(body.get("device_code")).toBe("DEVICE-SECRET");
        const next = answers.shift();
        return next === "ok"
          ? Response.json({ access_token: "AT1", refresh_token: "RT1", expires_in: 3600, scope: FULL })
          : Response.json({ error: next }, { status: 400 });
      },
      ...identity,
    });
    const c = new Connection(host, s.fetcher, clock);
    const view = await c.start({ origin: ORIGIN });
    expect(view).toMatchObject({ phase: "pending", userCode: "WDJB-MJHT" });
    expect(JSON.stringify(view)).not.toContain("DEVICE-SECRET");
    await advance(5000); // pending
    await advance(5000); // slow_down → interval becomes 10 s
    await advance(5000);
    expect(s.log.filter((l) => l.path === "/oauth/token")).toHaveLength(2);
    await advance(5000);
    const status = await c.status();
    expect(status.attempt?.phase).toBe("connected");
    expect(status.connection).toMatchObject({ username: "mara", canWrite: true, expired: false });
    expect(JSON.stringify(status)).not.toMatch(/AT1|RT1|DEVICE-SECRET/);
    expect(JSON.stringify(values.get("storage:connection"))).not.toMatch(/AT1|RT1/);
    expect(JSON.parse(values.get("secrets:oauth") as string)).toMatchObject({
      accessToken: "AT1",
      refreshToken: "RT1",
    });
  });

  it.each([
    ["access_denied", "denied"],
    ["expired_token", "expired"],
  ])("ends the attempt on %s without storing anything", async (error, phase) => {
    const { host, values } = hostFixture();
    const { clock, advance } = clockFixture();
    const s = server({
      "/oauth/device/authorize": deviceOk,
      "/oauth/token": () => Response.json({ error }, { status: 400 }),
    });
    const c = new Connection(host, s.fetcher, clock);
    await c.start({ origin: ORIGIN });
    await advance(5000);
    expect((await c.status()).attempt?.phase).toBe(phase);
    expect(values.size).toBe(0);
  });

  it("backs off while offline and still expires at the server deadline", async () => {
    const { host } = hostFixture();
    const { clock, advance } = clockFixture();
    const s = server({
      "/oauth/device/authorize": deviceOk,
      "/oauth/token": () => {
        throw new TypeError("network down");
      },
    });
    const c = new Connection(host, s.fetcher, clock);
    await c.start({ origin: ORIGIN });
    for (let i = 0; i < 40 && (await c.status()).attempt?.phase === "pending"; i++)
      await advance(60_000);
    expect((await c.status()).attempt?.phase).toBe("expired");
    expect(s.log.filter((l) => l.path === "/oauth/token").length).toBeLessThan(25);
  });

  it("names an unregistered client instead of a generic failure", async () => {
    const { host } = hostFixture();
    const s = server({
      "/oauth/device/authorize": () => Response.json({ error: "invalid_client" }, { status: 400 }),
    });
    const c = new Connection(host, s.fetcher, clockFixture().clock);
    await expect(c.start({ origin: ORIGIN })).rejects.toThrow("[invalid_client]");
  });

  it("never connects a cancelled attempt, and revokes tokens that arrive late", async () => {
    const { host, values } = hostFixture();
    const { clock, advance } = clockFixture();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const s = server({
      "/oauth/device/authorize": deviceOk,
      "/oauth/token": async () => {
        await gate;
        return Response.json({ access_token: "LATE", refresh_token: "LATE-R", expires_in: 3600, scope: "repo:read" });
      },
      "/oauth/revoke": () => new Response(null, { status: 200 }),
      ...identity,
    });
    const c = new Connection(host, s.fetcher, clock);
    const { attemptId } = (await c.start({ origin: ORIGIN }))!;
    const polling = advance(5000);
    await settle();
    await c.cancel({ attemptId });
    release();
    await polling;
    await settle();
    expect((await c.status()).attempt).toBeNull();
    expect(values.size).toBe(0);
    expect(
      s.log.filter((l) => l.path === "/oauth/revoke").map((l) => l.body.get("token")),
    ).toEqual(["LATE-R", "LATE"]);
  });

  it("hands the verified URL to Orca's browser authorization without blocking the command", async () => {
    let confirm!: (v: { opened: boolean }) => void;
    const { host, calls } = hostFixture({ open: () => new Promise((r) => (confirm = r)) });
    const s = server({ "/oauth/device/authorize": deviceOk, ...discovery() });
    const c = new Connection(host, s.fetcher, clockFixture().clock);
    const { attemptId, browser } = (await c.start({ origin: ORIGIN }))!;
    expect(browser).toBe("idle");
    // Returns while Orca's native confirmation is still open.
    expect(c.openVerification({ attemptId })).toMatchObject({ requested: true, browser: "confirming" });
    await settle();
    const create = calls.find((x) => x.method === "browser.createAuthorization")!.args as Record<string, unknown>;
    expect(create).toEqual({ serverOrigin: ORIGIN, verificationUrl: "http://localhost:5174/device?code=WDJB-MJHT", expiresIn: 900 });
    confirm({ opened: false });
    await settle();
    const view = (await c.status()).attempt!;
    expect(view).toMatchObject({ browser: "declined", verificationUri: "http://localhost:5174/device?code=WDJB-MJHT" });
    // The consumed handle was cancelled, so a retry may create a new one.
    expect(calls.filter((x) => x.method === "browser.cancelAuthorization")).toHaveLength(1);
    expect(JSON.stringify(await c.status())).not.toContain("00000000-0000-4000-8000");
    await expect(Promise.resolve().then(() => c.openVerification({ attemptId: "other" }))).rejects.toThrow("[no_attempt]");
  });

  it("refuses to open a verification URL the server's discovery does not vouch for", async () => {
    const { host, calls } = hostFixture();
    const s = server({
      "/oauth/device/authorize": () =>
        Response.json({ device_code: "D", user_code: "WDJB-MJHT", verification_uri: "https://phish.example/device", expires_in: 900, interval: 5 }),
      ...discovery(),
    });
    const c = new Connection(host, s.fetcher, clockFixture().clock);
    const { attemptId, browser, browserMessage } = (await c.start({ origin: ORIGIN }))!;
    expect(browser).toBe("unverified");
    expect(browserMessage).toContain("won’t open it");
    expect(c.openVerification({ attemptId })).toMatchObject({ requested: false, browser: "unverified" });
    expect(calls.some((x) => x.method.startsWith("browser."))).toBe(false);
  });

  it("without discovery metadata, trusts only a same-origin /device page", async () => {
    const same = server({
      "/oauth/device/authorize": () =>
        Response.json({ device_code: "D", user_code: "C", verification_uri: `${ORIGIN}/device`, expires_in: 900 }),
    });
    const other = server({ "/oauth/device/authorize": deviceOk });
    expect((await new Connection(hostFixture().host, same.fetcher, clockFixture().clock).start({ origin: ORIGIN }))!.browser).toBe("idle");
    expect((await new Connection(hostFixture().host, other.fetcher, clockFixture().clock).start({ origin: ORIGIN }))!.browser).toBe("unverified");
  });

  it("explains an Orca without browser:authorize and a host rate limit", async () => {
    const old = hostFixture({ create: () => { throw new Error("unknown method browser.createAuthorization"); } });
    const s = server({ "/oauth/device/authorize": deviceOk, ...discovery() });
    const c = new Connection(old.host, s.fetcher, clockFixture().clock);
    const { attemptId } = (await c.start({ origin: ORIGIN }))!;
    c.openVerification({ attemptId });
    await settle();
    expect((await c.status()).attempt).toMatchObject({ browser: "unavailable" });
    const busy = hostFixture({ create: () => { throw new Error("Authorization already pending or rate limited"); } });
    const c2 = new Connection(busy.host, s.fetcher, clockFixture().clock);
    const a2 = (await c2.start({ origin: ORIGIN }))!;
    c2.openVerification({ attemptId: a2.attemptId });
    await settle();
    expect((await c2.status()).attempt).toMatchObject({ browser: "rate_limited" });
  });

  it("cancels Orca's handle when sign-in ends", async () => {
    const { host, calls } = hostFixture({ open: () => ({ opened: true }) });
    const { clock, advance } = clockFixture();
    const s = server({
      "/oauth/device/authorize": deviceOk,
      "/oauth/token": () => Response.json({ error: "access_denied" }, { status: 400 }),
      ...discovery(),
    });
    const c = new Connection(host, s.fetcher, clock);
    const { attemptId } = (await c.start({ origin: ORIGIN }))!;
    c.openVerification({ attemptId });
    await settle();
    await advance(5000);
    expect((await c.status()).attempt?.phase).toBe("denied");
    const created = calls.filter((x) => x.method === "browser.createAuthorization").length;
    expect(calls.filter((x) => x.method === "browser.cancelAuthorization").length).toBeGreaterThanOrEqual(created);
  });
});

async function signedIn(extra: Record<string, Route> = {}, scope = FULL) {
  const h = hostFixture();
  const k = clockFixture();
  const refresh: Route =
    extra.refresh ?? (() => Response.json({ access_token: "AT2", refresh_token: "RT2", expires_in: 3600 }));
  const s = server({
    "/oauth/device/authorize": deviceOk,
    "/oauth/token": (body) =>
      body.get("grant_type") === "refresh_token"
        ? refresh(body)
        : Response.json({ access_token: "AT1", refresh_token: "RT1", expires_in: 3600, scope }),
    "/oauth/revoke": () => new Response(null, { status: 200 }),
    ...identity,
    ...extra,
  });
  const c = new Connection(h.host, s.fetcher, k.clock);
  await c.start({ origin: ORIGIN });
  await k.advance(5000);
  expect((await c.status()).attempt?.phase).toBe("connected");
  return { ...h, ...k, s, c };
}
const AFTER_EXPIRY = 1_000_000 + 5000 + 3600_000;

describe("OAuth session", () => {
  it("serializes concurrent refreshes and persists the rotated refresh token", async () => {
    let refreshes = 0;
    const t = await signedIn({
      refresh: async (body) => {
        refreshes++;
        expect(body.get("refresh_token")).toBe("RT1");
        await new Promise((r) => setTimeout(r, 5));
        return Response.json({ access_token: "AT2", refresh_token: "RT2", expires_in: 3600 });
      },
      "/api/v1/ping": () => Response.json({ ok: true }),
    });
    t.setNow(AFTER_EXPIRY);
    const client = await t.c.client();
    await Promise.all([client.json("/api/v1/ping"), client.json("/api/v1/ping")]);
    expect(refreshes).toBe(1);
    expect(JSON.parse(t.values.get("secrets:oauth") as string)).toMatchObject({
      accessToken: "AT2",
      refreshToken: "RT2",
    });
    const pings = t.s.log.filter((l) => l.path === "/api/v1/ping");
    expect(pings.every((l) => l.auth === "Bearer AT2")).toBe(true);
  });

  it("turns a rejected refresh into 'sign in again' and drops the tokens", async () => {
    const t = await signedIn({
      refresh: () => Response.json({ error: "invalid_grant" }, { status: 400 }),
    });
    t.setNow(AFTER_EXPIRY);
    await expect(t.c.client()).rejects.toThrow("[session_expired]");
    expect(t.values.has("secrets:oauth")).toBe(false);
    expect((await t.c.status()).connection).toMatchObject({ expired: true, username: "mara" });
  });

  it("retries a read once after a 401 but never replays a write", async () => {
    let reads = 0;
    let writes = 0;
    const t = await signedIn({
      "/api/v1/read": () =>
        ++reads === 1 ? new Response("", { status: 401 }) : Response.json({ ok: true }),
      "/api/v1/write": () => {
        writes++;
        return new Response("", { status: 401 });
      },
    });
    const client = await t.c.client();
    expect(await client.json("/api/v1/read")).toEqual({ ok: true });
    await expect(client.json("/api/v1/write", { method: "POST", body: "{}" })).rejects.toThrow(
      "[unauthorized]",
    );
    expect(writes).toBe(1);
  });

  it("respects a read-only grant", async () => {
    const t = await signedIn({}, "profile repo:read offline_access");
    expect((await t.c.status()).connection).toMatchObject({ canWrite: false });
    expect((await t.c.client()).canWrite).toBe(false);
  });

  it("clears local credentials on sign-out and reports remote revocation separately", async () => {
    const t = await signedIn({ "/oauth/revoke": () => new Response("", { status: 503 }) });
    expect(await t.c.disconnect()).toEqual({ signedOut: true, revoked: false });
    expect(t.values.size).toBe(0);
    await expect(t.c.client()).rejects.toThrow("[signed_out]");
  });

  it("asks a PAT-era profile to sign in with OAuth and deletes the PAT on success", async () => {
    const h = hostFixture();
    h.values.set("storage:connection", {
      connectionId: "old",
      origin: ORIGIN,
      mcpUrl: `${ORIGIN}/mcp`,
      username: "mara",
      userId: "u1",
    });
    h.values.set("secrets:pat", "cv_pat_old");
    const k = clockFixture();
    const s = server({
      "/oauth/device/authorize": deviceOk,
      "/oauth/token": () =>
        Response.json({ access_token: "AT1", refresh_token: "RT1", expires_in: 3600, scope: FULL }),
      ...identity,
    });
    const c = new Connection(h.host, s.fetcher, k.clock);
    expect((await c.status()).legacy).toEqual({ origin: ORIGIN, username: "mara" });
    await expect(c.client()).rejects.toThrow("[reauth_required]");
    await c.start({ origin: ORIGIN });
    await k.advance(5000);
    expect(h.values.has("secrets:pat")).toBe(false);
    expect((await c.status()).connection?.username).toBe("mara");
  });

  it("rejects cross-origin MCP discovery before storing credentials", async () => {
    const h = hostFixture();
    const k = clockFixture();
    const s = server({
      "/oauth/device/authorize": deviceOk,
      "/oauth/token": () => Response.json({ access_token: "AT1", expires_in: 3600, scope: "repo:read" }),
      "/oauth/revoke": () => new Response(null, { status: 200 }),
      "/api/auth/me": identity["/api/auth/me"],
      "/api/mcp/connection-info": () =>
        Response.json({ mcpUrl: "https://evil.example/mcp", transport: "streamable-http" }),
    });
    const c = new Connection(h.host, s.fetcher, k.clock);
    await c.start({ origin: ORIGIN });
    await k.advance(5000);
    expect((await c.status()).attempt).toMatchObject({ phase: "error" });
    expect(h.values.size).toBe(0);
    expect(s.log.some((l) => l.path === "/oauth/revoke")).toBe(true);
  });
});
