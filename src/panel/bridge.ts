/** The panel's only way out: Orca's frozen `window.orca` frame API. Every former
 *  host-patch call goes through one of these wrappers, typed end to end by the
 *  `PluginRequests` / `PluginPanelEvents` contract in src/shared/protocol.ts. */
import type { Disposable, JsonValue } from "orca/host";
import type {
  PluginRequestInput,
  PluginRequestOptions,
  PluginRequestOutput,
  PluginRequests,
  PluginPanelEvents,
} from "orca";

export type Failure = { code: string; message: string };

/** Host error codes the bridge itself can reject with; the worker's own codes
 *  arrive as `[code] message` strings. */
const HOST_CODES = new Set([
  "invalid_request",
  "invalid_params",
  "unknown_method",
  "capability_denied",
  "consent_required",
  "not_permitted",
  "rate_limited",
  "unavailable",
  "action_failed",
  "cancelled",
  "timeout",
  "conflict",
  "too_large",
]);

/** A short, safe failure: worker codes carry their message; anything else collapses to a
 *  generic line so response bodies, headers or stack traces never reach the panel. */
export function failure(error: unknown): Failure {
  const text = error instanceof Error ? error.message : String(error ?? "Request failed");
  const coded = /^\[([a-z_]+)\]\s*([\s\S]*)$/.exec(text);
  if (coded)
    return {
      code: coded[1],
      message: coded[2].trim().slice(0, 300) || coded[1].replace(/_/g, " "),
    };
  const code = typeof (error as { code?: unknown })?.code === "string" ? (error as { code: string }).code : "";
  if (HOST_CODES.has(code)) return { code, message: text.slice(0, 300) };
  return { code: "error", message: "Something went wrong." };
}

/** Runs a handler the worker registered with `orca.panels.handle`, starting the worker if
 *  it is not running. Rejects with the worker's own `[code]` message, a host code, or
 *  `unavailable` when the worker cannot start. */
export function req<K extends keyof PluginRequests>(
  name: K,
  input: PluginRequestInput<K>,
  options?: PluginRequestOptions,
): Promise<PluginRequestOutput<K>> {
  // Through the declared generic the conditional argument tuple defeats the checker, so the
  // call goes through the same bridge with its names and JSON spelled plainly.
  const bridge = orca.plugin as {
    request(name: string, input?: JsonValue, options?: PluginRequestOptions): Promise<JsonValue>;
  };
  return bridge.request(name, input as JsonValue, options) as Promise<PluginRequestOutput<K>>;
}

/** Subscribes to what the worker pushes with `orca.panels.post`. */
export function onPush<K extends keyof PluginPanelEvents>(
  event: K,
  handler: (payload: PluginPanelEvents[K]) => void,
): Disposable {
  return orca.plugin.on(event, handler);
}

/** Opens a URL in the person's browser from a click or key press. `opened: false` means
 *  they (or Orca) declined, or this client has no `shell` (browser clients never offer it);
 *  the caller then shows the address for manual navigation. */
export async function openExternal(url: string): Promise<{ opened: boolean; reason?: string }> {
  if (!orca.shell || !orca.host.has("shell.openExternal")) return { opened: false, reason: "unavailable" };
  try {
    return await orca.shell.openExternal(url);
  } catch {
    return { opened: false };
  }
}

// ---------- the last repository used on an account ----------

export interface RepoChoice {
  origin: string;
  userId: string;
  owner: string;
  repo: string;
}

const choice = (value: JsonValue | null): RepoChoice | null =>
  typeof value === "object" &&
  value !== null &&
  ["origin", "userId", "owner", "repo"].every((key) => typeof (value as Record<string, unknown>)[key] === "string")
    ? (value as unknown as RepoChoice)
    : null;

/** Remembers the repository last used on this account, in the plugin's own storage
 *  (the same store the worker uses; worker keys never collide with `repoChoice`). */
export async function rememberRepo(value: RepoChoice): Promise<void> {
  await orca.storage.set("repoChoice", value as unknown as JsonValue).catch(() => undefined);
}

export async function recallRepo(): Promise<RepoChoice | null> {
  try {
    return choice(await orca.storage.get("repoChoice"));
  } catch {
    return null;
  }
}
