import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { z } from "zod";
export async function searchCode(
  connection: { mcpUrl: string; origin: string; token: string },
  input: { owner: string; repo: string; query: string },
) {
  const endpoint = new URL(connection.mcpUrl);
  if (endpoint.origin !== connection.origin) throw new Error("MCP origin mismatch");
  const client = new Client({ name: "cv-hub-orca", version: "0.1.0" });
  const transport = new StreamableHTTPClientTransport(endpoint, {
    requestInit: { headers: { Authorization: `Bearer ${connection.token}` }, redirect: "error" },
    fetch: async (url, init) => {
      const target = new URL(url);
      if (target.origin !== connection.origin) throw new Error("MCP origin mismatch");
      return fetch(url, {
        ...init,
        redirect: "error",
        signal: init?.signal
          ? AbortSignal.any([init.signal, AbortSignal.timeout(20000)])
          : AbortSignal.timeout(20000),
      });
    },
  });
  try {
    await client.connect(transport);
    const { tools } = await client.listTools();
    if (!tools.some((tool) => tool.name === "search_code"))
      throw new Error("This CV Hub deployment does not provide code search");
    const result = await client.callTool({
      name: "search_code",
      arguments: { ...input, limit: 8 },
    });
    const response = z
      .object({
        isError: z.boolean().optional(),
        content: z.array(z.object({ type: z.string(), text: z.string().optional() })),
      })
      .parse(result);
    const text = response.content
      .filter((item) => item.type === "text")
      .map((item) => item.text ?? "")
      .join("\n");
    if (response.isError)
      throw new Error(
        text.replaceAll(connection.token, "[redacted]").slice(0, 512) || "Code search failed",
      );
    if (text.length > 1024 * 1024) throw new Error("Search response is too large");
    return z
      .array(
        z.object({
          file_path: z.string(),
          content: z.string(),
          symbol_name: z.string().nullable().optional(),
          start_line: z.number().nullable().optional(),
        }),
      )
      .parse(JSON.parse(text))
      .slice(0, 8)
      .map((item) => ({
        path: item.file_path,
        symbol: item.symbol_name ?? "",
        line: item.start_line,
        content: item.content.slice(0, 2500),
      }));
  } finally {
    await client.close().catch(() => undefined);
  }
}
