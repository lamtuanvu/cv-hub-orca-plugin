import { afterEach, expect, it, vi } from "vitest";
import { searchCode } from "./mcp-client";
afterEach(() => vi.unstubAllGlobals());
it("initializes MCP, discovers search, sends auth, and bounds returned snippets", async () => {
  const calls: Array<{ method: string; params?: unknown }> = [];
  vi.stubGlobal("fetch", async (url: string | URL, init: RequestInit) => {
    expect(new URL(url).origin).toBe("https://hub.example");
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer secret");
    expect(init.redirect).toBe("error");
    if (init.method !== "POST") return new Response(null, { status: 405 });
    const message = JSON.parse(String(init.body));
    calls.push(message);
    if (!("id" in message)) return new Response(null, { status: 202 });
    const result =
      message.method === "initialize"
        ? {
            protocolVersion: "2025-03-26",
            capabilities: { tools: {} },
            serverInfo: { name: "fixture", version: "1" },
          }
        : message.method === "tools/list"
          ? { tools: [{ name: "search_code", inputSchema: { type: "object" } }] }
          : {
              content: [
                {
                  type: "text",
                  text: JSON.stringify([
                    {
                      file_path: "hello.ts",
                      content: "x".repeat(3000),
                      start_line: 1,
                      symbol_name: "hello",
                    },
                  ]),
                },
              ],
            };
    return Response.json({ jsonrpc: "2.0", id: message.id, result });
  });
  const result = await searchCode(
    { origin: "https://hub.example", mcpUrl: "https://hub.example/mcp", token: "secret" },
    { owner: "acme", repo: "demo", query: "hello" },
  );
  expect(result).toEqual([
    { path: "hello.ts", symbol: "hello", line: 1, content: "x".repeat(2500) },
  ]);
  expect(calls.find((call) => call.method === "tools/call")?.params).toMatchObject({
    name: "search_code",
    arguments: { owner: "acme", repo: "demo", query: "hello", limit: 8 },
  });
});
