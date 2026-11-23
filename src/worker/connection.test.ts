import { describe, expect, it } from "vitest";
import { CLIENT_ID, Connection, safeBrowserUrl, type Clock, type ConnectionPort } from "./connection";

function portFixture(seed: Record<string, unknown> = {}) {
  const storageValues = new Map<string, unknown>(Object.entries(seed));
  const secretValues = new Map<string, string>();
  const port: ConnectionPort = {
    storage: {
      get: async (key) => storageValues.get(key) ?? null,
      set: async (key, value) => void storageValues.set(key, value),
      delete: async (key) => void storageValues.delete(key),
    },
    secrets: {
      get: async (key) => secretValues.get(key) ?? null,
      set: async (key, value) => void secretValues.set(key, value),
      delete: async (key) => void secretValues.delete(key),
    },
  };
  return { port, storageValues, secretValues };
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
const FULL = "profile repo:read repo:write offline_access";

describe("OAuth device sign-in", () => {
  it("polls through pending and slow_down, then keeps tokens only in the vault", async () => {
    const { port, storageValues, secretValues } = portFixture();
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
    let changes = 0;
    const c = new Connection(port, s.fetcher, clock, () => changes++);
    const view = await c.start(ORIGIN);
    expect(view).toMatchObject({
      phase: "pending",
      userCode: "WDJB-MJHT",
      verified: true,
      verificationUri: "http://localhost:5174/device?code=WDJB-MJHT",
    });
    expect(JSON.stringify(view)).not.toContain("DEVICE-SECRET");
    await advance(5000); // pending
    await advance(5000); // slow_down → interval becomes 10 s
    await advance(5000);
    expect(s.log.filter((l) => l.path === "/oauth/token")).toHaveLength(2);
    await advance(5000);
    const status = await c.status();
    expect(status.attempt?.phase).toBe("connected");
    expect(status.connection).toMatchObject({ username: "mara", canWrite: true, expired: false, webOrigin: "http://localhost:5174" });
    expect(await new Connection(port, s.fetcher, clock).profile()).toMatchObject({ webOrigin: "http://localhost:5174" });
    expect(JSON.stringify(status)).not.toMatch(/AT1|RT1|DEVICE-SECRET/);
    expect(JSON.stringify(storageValues.get("connection"))).not.toMatch(/AT1|RT1/);
    expect(JSON.parse(secretValues.get("oauth") as string)).toMatchObject({
      accessToken: "AT1",
      refreshToken: "RT1",
    });
    // Every phase change reached the panel through the worker's post.
    expect(changes).toBeGreaterThanOrEqual(2);
  });

  it.each([
    ["access_denied", "denied"],
    ["expired_token", "expired"],
  ])("ends the attempt on %s without storing anything", async (error, phase) => {
    const { port, storageValues } = portFixture();
    const { clock, advance } = clockFixture();
    const s = server({
      "/oauth/device/authorize": deviceOk,
      "/oauth/token": () => Response.json({ error }, { status: 400 }),
    });
    const c = new Connection(port, s.fetcher, clock);
    await c.start(ORIGIN);
    await advance(5000);
    expect((await c.status()).attempt?.phase).toBe(phase);
    expect(storageValues.size).toBe(0);
  });

  it("backs off while offline and still expires at the server deadline", async () => {
    const { port } = portFixture();
    const { clock, advance } = clockFixture();
    const s = server({
      "/oauth/device/authorize": deviceOk,
      "/oauth/token": () => {
        throw new TypeError("network down");
      },
    });
    const c = new Connection(port, s.fetcher, clock);
    await c.start(ORIGIN);
    for (let i = 0; i < 40 && (await c.status()).attempt?.phase === "pending"; i++)
      await advance(60_000);
    expect((await c.status()).attempt?.phase).toBe("expired");
    expect(s.log.filter((l) => l.path === "/oauth/token").length).toBeLessThan(25);
  });

  it("names an unregistered client instead of a generic failure", async () => {
    const { port } = portFixture();
    const s = server({
      "/oauth/device/authorize": () => Response.json({ error: "invalid_client" }, { status: 400 }),
    });
    const c = new Connection(port, s.fetcher, clockFixture().clock);
    await expect(c.start(ORIGIN)).rejects.toThrow("[invalid_client]");
  });

  it("never connects a cancelled attempt, and revokes tokens that arrive late", async () => {
    const { port, storageValues } = portFixture();
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
    const c = new Connection(port, s.fetcher, clock);
    const { attemptId } = (await c.start(ORIGIN))!;
    const polling = advance(5000);
    await settle();
    await c.cancel(attemptId);
    release();
    await polling;
    await settle();
    expect((await c.status()).attempt).toBeNull();
    expect(storageValues.size).toBe(0);
    expect(
      s.log.filter((l) => l.path === "/oauth/revoke").map((l) => l.body.get("token")),
    ).toEqual(["LATE-R", "LATE"]);
  });

  it("refuses to offer a verification URL outside this deployment", async () => {
    const { port } = portFixture();
    const s = server({
      "/oauth/device/authorize": () =>
        Response.json({ device_code: "D", user_code: "WDJB-MJHT", verification_uri: "https://phish.example/device", expires_in: 900, interval: 5 }),
    });
    const c = new Connection(port, s.fetcher, clockFixture().clock);
    const { verified, verificationUri, message } = (await c.start(ORIGIN))!;
    expect(verified).toBe(false);
    expect(verificationUri).toBe("https://phish.example/device");
    expect(message).toContain("trust it");
  });

  it("trusts CV Hub's approval page on the API origin or the web host beside an api. host", async () => {
    const verifiedFor = async (origin: string, verification: string) => {
      const { port } = portFixture();
      const s = server({
        "/oauth/device/authorize": () =>
          Response.json({ device_code: "D", user_code: "C", verification_uri: verification, expires_in: 900 }),
      });
      return (await new Connection(port, s.fetcher, clockFixture().clock).start(origin))!.verified;
    };
    // Production layout: api.hub.example.com serves the API, hub.example.com the web app.
    expect(await verifiedFor("https://api.hub.example.com", "https://hub.example.com/device")).toBe(true);
    expect(await verifiedFor("https://api.hub.example.com", "https://api.hub.example.com/device")).toBe(true);
    expect(await verifiedFor("https://hub.example.com", "https://hub.example.com/device")).toBe(true);
    // Local development: the web app runs on its own loopback port.
    expect(await verifiedFor(ORIGIN, "http://localhost:5174/device")).toBe(true);
    for (const [origin, url] of [
      ["https://api.hub.example.com", "https://evil.example.com/device"],
      ["https://api.hub.example.com", "https://hub.example.com.evil.example/device"],
      ["https://api.hub.example.com", "https://hub.example.com/login"],
      ["https://api.hub.example.com", "https://hub.example.com:8443/device"],
      ["https://hub.example.com", "https://example.com/device"],
      ["https://api.hub.example.com", "http://localhost:5174/device"],
    ])
      expect(await verifiedFor(origin, url)).toBe(false);
  });

  it("refuses unsafe verification addresses outright", () => {
    expect(() => safeBrowserUrl("https://user:pass@hub.example.com/device")).toThrow("[unsafe_url]");
    expect(() => safeBrowserUrl("ftp://hub.example.com/device")).toThrow("[unsafe_url]");
  });
});

async function signedIn(extra: Record<string, Route> = {}, scope = FULL) {
  const p = portFixture();
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
  const c = new Connection(p.port, s.fetcher, k.clock);
  await c.start(ORIGIN);
  await k.advance(5000);
  expect((await c.status()).attempt?.phase).toBe("connected");
  return { ...p, ...k, s, c };
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
    expect(JSON.parse(t.secretValues.get("oauth") as string)).toMatchObject({
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
    expect(t.secretValues.has("oauth")).toBe(false);
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
    expect(t.storageValues.size).toBe(0);
    expect(t.secretValues.size).toBe(0);
    await expect(t.c.client()).rejects.toThrow("[signed_out]");
  });

  it("asks a PAT-era profile to sign in with OAuth and deletes the PAT on success", async () => {
    const { port, storageValues, secretValues } = portFixture({
      connection: {
        connectionId: "old",
        origin: ORIGIN,
        mcpUrl: `${ORIGIN}/mcp`,
        username: "mara",
        userId: "u1",
      },
    });
    secretValues.set("pat", "cv_pat_old");
    const k = clockFixture();
    const s = server({
      "/oauth/device/authorize": deviceOk,
      "/oauth/token": () =>
        Response.json({ access_token: "AT1", refresh_token: "RT1", expires_in: 3600, scope: FULL }),
      ...identity,
    });
    const c = new Connection(port, s.fetcher, k.clock);
    expect((await c.status()).legacy).toEqual({ origin: ORIGIN, username: "mara" });
    await expect(c.client()).rejects.toThrow("[reauth_required]");
    await c.start(ORIGIN);
    await k.advance(5000);
    expect(secretValues.has("pat")).toBe(false);
    expect((await c.status()).connection?.username).toBe("mara");
    expect(storageValues.size).toBe(1);
  });

  it("rejects cross-origin MCP discovery before storing credentials", async () => {
    const { port, storageValues } = portFixture();
    const k = clockFixture();
    const s = server({
      "/oauth/device/authorize": deviceOk,
      "/oauth/token": () => Response.json({ access_token: "AT1", expires_in: 3600, scope: "repo:read" }),
      "/oauth/revoke": () => new Response(null, { status: 200 }),
      "/api/auth/me": identity["/api/auth/me"],
      "/api/mcp/connection-info": () =>
        Response.json({ mcpUrl: "https://evil.example/mcp", transport: "streamable-http" }),
    });
    const c = new Connection(port, s.fetcher, k.clock);
    await c.start(ORIGIN);
    await k.advance(5000);
    expect((await c.status()).attempt).toMatchObject({ phase: "error" });
    expect(storageValues.size).toBe(0);
    expect(s.log.some((l) => l.path === "/oauth/revoke")).toBe(true);
  });
});
