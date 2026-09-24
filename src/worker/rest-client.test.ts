import { describe, expect, it } from "vitest";
import { RestClient, normalizeOrigin } from "./rest-client";

describe("CV Hub HTTP boundary", () => {
  it("keeps credentials on the configured origin and refuses redirects", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const client = new RestClient("https://hub.example", "secret", async (url, init) => {
      requests.push({ url: String(url), init });
      return Response.json({ ok: true });
    });
    expect(await client.json("/api/auth/me")).toEqual({ ok: true });
    expect(requests[0].url).toBe("https://hub.example/api/auth/me");
    expect(requests[0].init?.redirect).toBe("error");
    await expect(client.json("https://evil.example")).rejects.toThrow();
    await expect(client.json("//evil.example")).rejects.toThrow();
    expect(requests).toHaveLength(1);
  });
  it("bounds bodies even without Content-Length and does not retry writes", async () => {
    let calls = 0;
    const client = new RestClient("https://hub.example", "secret", async () => {
      calls++;
      return new Response("x".repeat(100));
    });
    await expect(client.json("/api/test", { method: "POST" }, 10)).rejects.toThrow("limit");
    expect(calls).toBe(1);
  });
  it("turns authentication failures into safe actionable errors", async () => {
    const client = new RestClient(
      "https://hub.example",
      "secret",
      async () => new Response("secret", { status: 401 }),
    );
    await expect(client.json("/api/test")).rejects.toThrow("Sign in again");
  });
  it("allows HTTPS and loopback development only, without URL credentials", () => {
    expect(normalizeOrigin("https://hub.example/")).toBe("https://hub.example");
    expect(normalizeOrigin("http://localhost:3000")).toBe("http://localhost:3000");
    for (const url of [
      "http://hub.example",
      "https://user:pass@hub.example",
      "https://hub.example/path",
      "file:///tmp",
    ])
      expect(() => normalizeOrigin(url)).toThrow();
  });
});
