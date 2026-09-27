import { z } from "zod";
import { command, hostCall } from "./bridge";
import { h, add, button, type Child } from "./dom";
import { icon, spinner, type IconName } from "./icons";
import { markdown } from "./markdown";
import { watchTheme } from "./theme";
import { DEFAULT_ORIGIN } from "../shared/contracts";
import { pullWebUrl } from "../shared/pull-url";
import logoUrl from "./assets/cv-hub-mono.svg";
import "./style.css";

// ───────────────────────── errors ─────────────────────────
type Failure = { code: string; message: string };
function failure(error: unknown): Failure {
  const text = error instanceof Error ? error.message : String(error ?? "Request failed");
  const m = /^\[([a-z_]+)\]\s*([\s\S]*)$/.exec(text);
  // Anything without a worker code is shown as a short, generic message; the raw text only
  // goes into the collapsed diagnostics, bounded, never a stack.
  return m ? { code: m[1], message: m[2] } : { code: "error", message: text.slice(0, 300) };
}
const AUTH_CODES = new Set(["session_expired", "reauth_required", "signed_out"]);
/** Host-side failures carry no worker code. Recognise an Orca without the hardened host and a
 *  review invalidated by a plugin refresh, and say what to do instead of a raw message. */
function hostFailure(f: Failure): Failure {
  if (f.code !== "error") return f;
  if (/unknown (action|method)|not (granted|supported|declared)|provider|commandId|unrecognized/i.test(f.message))
    return { code: "host_unsupported", message: "This Orca build can’t open CV Hub reviews natively. It needs the hardened plugin review host (lamtuanvu/orca 75b02825 or later)." };
  if (/unavailable|revoked|generation|invalid/i.test(f.message))
    return { code: "review_reset", message: "Orca reset the review session (the plugin was refreshed or updated). Open the changes again." };
  return { code: "error", message: "Orca couldn’t open the review. Try again." };
}

// ───────────────────────── schemas ─────────────────────────
const connectionSchema = z.object({
  origin: z.string(),
  webOrigin: z.string().nullable(),
  mcpUrl: z.string(),
  username: z.string(),
  userId: z.string(),
  displayName: z.string().nullable(),
  canWrite: z.boolean(),
  expired: z.boolean(),
});
const BROWSER = ["idle", "confirming", "opened", "declined", "unavailable", "unverified", "rate_limited", "invalidated"] as const;
const attemptSchema = z.object({
  attemptId: z.string(),
  origin: z.string(),
  phase: z.enum(["pending", "denied", "expired", "offline", "invalid_client", "error", "connected"]),
  userCode: z.string(),
  verificationUri: z.string(),
  expiresAt: z.number(),
  message: z.string().nullable(),
  browser: z.enum(BROWSER),
  browserMessage: z.string().nullable(),
});
const statusSchema = z.object({
  connection: connectionSchema.nullable(),
  legacy: z.object({ origin: z.string(), username: z.string() }).nullable(),
  attempt: attemptSchema.nullable(),
});
type Connection = z.infer<typeof connectionSchema>;
type Attempt = z.infer<typeof attemptSchema>;
const repoListSchema = z.object({
  repositories: z.array(z.object({ owner: z.string(), repo: z.string() })),
  total: z.number(),
});
type Repo = { owner: string; repo: string };
const pullSummarySchema = z.object({
  number: z.number(),
  title: z.string(),
  state: z.string(),
  isDraft: z.boolean(),
  author: z.string(),
  updatedAt: z.string().nullable(),
});
const pullDetailSchema = pullSummarySchema.extend({
  body: z.string(),
  sourceBranch: z.string(),
  targetBranch: z.string(),
  sourceSha: z.string().nullable(),
  createdAt: z.string().nullable(),
  canWrite: z.boolean(),
});
type PullSummary = z.infer<typeof pullSummarySchema>;
type PullDetail = z.infer<typeof pullDetailSchema>;
const checksSchema = z.object({
  checks: z.array(
    z.object({
      name: z.string(),
      status: z.string(),
      conclusion: z.string().nullable(),
      durationMs: z.number().nullable().optional(),
    }),
  ),
  total: z.number(),
});
const reviewsSchema = z.object({
  reviews: z.array(
    z.object({
      id: z.string(),
      state: z.string(),
      body: z.string(),
      commitSha: z.string().nullable().optional(),
      submittedAt: z.string().nullable().optional(),
      createdAt: z.string().optional(),
      reviewer: z.string().nullable(),
    }),
  ),
  total: z.number(),
});
const searchResultsSchema = z.object({ results: z.lazy(() => searchSchema) });
const searchSchema = z.array(
  z.object({ path: z.string(), symbol: z.string(), line: z.number().nullable().optional(), content: z.string() }),
);
type Check = z.infer<typeof checksSchema>["checks"][number];
type Review = z.infer<typeof reviewsSchema>["reviews"][number];

// ───────────────────────── state ─────────────────────────
type Load<T> = { status: "idle" | "loading" | "ready" | "error"; data: T; error?: Failure };
const idle = <T,>(data: T): Load<T> => ({ status: "idle", data });
type Kind = "commented" | "approved" | "changes_requested";
type Draft = { kind: Kind; body: string };
type Submit = { status: "idle" | "submitting" | "ok" | "error" | "uncertain" | "checking" | "verified" | "stale"; text?: string };
type Filter = "open" | "merged" | "closed" | "all" | "mine";
const PAGE = 20;

const S = {
  booted: false,
  wide: false,
  conn: null as Connection | null,
  legacy: null as { origin: string; username: string } | null,
  attempt: null as Attempt | null,
  auth: { busy: false, error: null as Failure | null, server: DEFAULT_ORIGIN, showSettings: false, serverError: "", copied: "" as "" | "Code" | "Address" },
  screen: "auth" as "auth" | "repos" | "main",
  repos: idle<{ items: Array<{ owner: string; repo: string }>; total: number }>({ items: [], total: 0 }),
  repoQuery: "",
  repoOffset: 0,
  repo: null as Repo | null,
  tab: "prs" as "prs" | "search",
  filter: "open" as Filter,
  prOffset: 0,
  prs: idle<{ items: PullSummary[]; total: number }>({ items: [], total: 0 }),
  selected: null as number | null,
  view: "list" as "list" | "detail",
  detail: idle<PullDetail | null>(null),
  checks: idle<{ items: Check[]; total: number }>({ items: [], total: 0 }),
  reviews: idle<{ items: Review[]; total: number }>({ items: [], total: 0 }),
  detailTab: "overview" as "overview" | "checks" | "reviews",
  viewer: "idle" as "idle" | "opening" | "error",
  viewerError: null as Failure | null,
  notice: null as { kind: "ok" | "warn"; text: string } | null,
  inspected: new Map<string, string>(),
  drafts: new Map<string, Draft>(),
  submits: new Map<string, Submit>(),
  search: { q: "", lastQ: "", ...idle<Array<z.infer<typeof searchSchema>[number]>>([]) },
  menuOpen: false,
};
const seq = { repos: 0, prs: 0, detail: 0, search: 0, auth: 0, submit: 0 };
let listScroll = 0;
let focusAfter: string | null = null;

const app = document.getElementById("app")!;
const view = document.getElementById("view")!;
const live = document.getElementById("announce")!;
let flip = false;
function say(text: string) {
  flip = !flip;
  live.textContent = text + (flip ? "" : "​");
}
const accountKey = () => (S.conn ? `${S.conn.origin}|${S.conn.userId}` : "anon");
const prKey = (n: number | null = S.selected) => `${accountKey()}|${S.repo?.owner}/${S.repo?.repo}#${n}`;
const slug = (r: Repo | null) => (r ? `${r.owner}/${r.repo}` : "");
const short = (sha?: string | null) => (sha ? sha.slice(0, 7) : "");
const host = (origin: string) => {
  try {
    return new URL(origin).host;
  } catch {
    return origin;
  }
};
function ago(iso?: string | null) {
  if (!iso) return "";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  if (s < 172800) return "yesterday";
  if (s < 30 * 86400) return `${Math.floor(s / 86400)} days ago`;
  return new Date(t).toLocaleDateString();
}

// ───────────────────────── render loop ─────────────────────────
let scheduled = false;
function render() {
  if (scheduled) return;
  scheduled = true;
  queueMicrotask(() => {
    scheduled = false;
    const active = document.activeElement as HTMLElement | null;
    const focusKey = focusAfter ?? active?.dataset?.fk ?? null;
    const caret =
      active && (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement)
        ? [active.selectionStart, active.selectionEnd]
        : null;
    const scrolls = new Map<string, number>();
    view.querySelectorAll<HTMLElement>("[data-sk]").forEach((el) => scrolls.set(el.dataset.sk!, el.scrollTop));
    view.replaceChildren();
    add(view, ...screen());
    view.querySelectorAll<HTMLElement>("[data-sk]").forEach((el) => {
      const v = scrolls.get(el.dataset.sk!);
      if (v !== undefined) el.scrollTop = v;
    });
    if (focusKey) {
      const el = view.querySelector<HTMLElement>(`[data-fk="${CSS.escape(focusKey)}"]`);
      if (el) {
        el.focus();
        if (caret && !focusAfter && (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement))
          el.setSelectionRange(caret[0], caret[1]);
      }
    }
    focusAfter = null;
  });
}
function focusNext(key: string) {
  focusAfter = key;
}

// ───────────────────────── small pieces ─────────────────────────
function note(kind: "" | "warn" | "err" | "ok", ic: IconName, body: Child, actions: Child[] = [], failureDetail?: Failure) {
  return h(
    "div",
    { class: `note ${kind}`, role: kind === "err" ? "alert" : undefined },
    icon(ic),
    h(
      "div",
      { class: "c" },
      h("div", null, body),
      actions.length ? h("div", { class: "acts" }, actions) : null,
      failureDetail && failureDetail.code !== "error"
        ? null
        : failureDetail
          ? h("details", { class: "diag" }, h("summary", null, "Details"), h("pre", null, failureDetail.message))
          : null,
    ),
  );
}
function errorNote(what: string, f: Failure, retry?: () => void, extra: Child[] = []) {
  return note(
    "err",
    "warn",
    [h("b", null, what), " ", f.code === "error" ? "Something went wrong." : f.message],
    [retry ? button({ class: "btn sm", onClick: retry }, "Retry") : null, ...extra],
    f,
  );
}
function empty(ic: IconName, title: string, text: string, action?: Child) {
  return h("div", { class: "empty" }, icon(ic), h("div", { class: "t" }, title), h("div", { class: "sm" }, text), action ?? null);
}
function skeleton(rows = 5) {
  return h(
    "div",
    { "aria-busy": "true", "aria-label": "Loading" },
    Array.from({ length: rows }, (_, i) =>
      h(
        "div",
        { class: "skr" },
        h("div", { class: "sk", style: "width:16px;height:16px" }),
        h(
          "div",
          { style: "flex:1;display:flex;flex-direction:column;gap:6px" },
          h("div", { class: "sk", style: `width:${[85, 70, 90, 60, 78][i % 5]}%` }),
          h("div", { class: "sk", style: "width:40%;height:8px" }),
        ),
      ),
    ),
  );
}
/** Flex rows only space separate elements; bare adjacent text would merge into one item. */
const sep = () => h("span", { "aria-hidden": "true" }, "·");
type PrState = "open" | "draft" | "merged" | "closed";
const prState = (p: PullSummary): PrState =>
  p.state === "merged" ? "merged" : p.state === "closed" ? "closed" : p.isDraft || p.state === "draft" ? "draft" : "open";
const STATE_LABEL: Record<PrState, string> = { open: "Open", draft: "Draft", merged: "Merged", closed: "Closed" };
const STATE_ICON: Record<PrState, IconName> = { open: "pr", draft: "pr", merged: "checkCircle", closed: "cancel" };
function listKeys(e: KeyboardEvent) {
  if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) return;
  const items = Array.from((e.currentTarget as HTMLElement).querySelectorAll<HTMLElement>("[data-nav]"));
  if (!items.length) return;
  let i = items.indexOf(document.activeElement as HTMLElement);
  i = e.key === "Home" ? 0 : e.key === "End" ? items.length - 1 : e.key === "ArrowDown" ? Math.min(items.length - 1, i + 1) : Math.max(0, i - 1);
  e.preventDefault();
  items[i].focus();
}

// ───────────────────────── screens ─────────────────────────
function screen(): Child[] {
  if (!S.booted) return [h("div", { class: "auth" }, skeleton(3))];
  const out: Child[] = [];
  if (S.conn && !S.conn.expired && S.screen !== "auth") out.push(header());
  if (S.screen === "auth" || !S.conn || S.conn.expired) out.push(authScreen());
  else if (S.screen === "repos") out.push(reposScreen());
  else out.push(mainScreen());
  if (S.menuOpen && S.conn) out.push(...accountMenu());
  return out;
}

function header() {
  const r = S.repo;
  return h(
    "div",
    { class: "hdr" },
    button(
      { class: "rsw", "data-fk": "rsw", "aria-label": r ? `Switch repository, current ${slug(r)}` : "Select a repository", onClick: openRepos },
      icon("repo", "s mut"),
      r ? h("span", { class: "trunc" }, h("span", { class: "own" }, `${r.owner} / `), h("span", { class: "nm" }, r.repo)) : h("span", { class: "trunc mut" }, "Select a repository"),
      icon("expand", "s mut"),
    ),
    button({ class: "ib", "aria-label": "Refresh", title: "Refresh", onClick: refresh }, icon("refresh", "s")),
    button(
      {
        class: "avb",
        "data-fk": "acct",
        "aria-label": `Account: ${S.conn!.displayName || S.conn!.username}, signed in to ${host(S.conn!.origin)}`,
        "aria-haspopup": "menu",
        "aria-expanded": String(S.menuOpen),
        onClick: () => {
          S.menuOpen = !S.menuOpen;
          if (S.menuOpen) focusNext("menu-first");
          render();
        },
      },
      h("span", { class: "av" }, (S.conn!.displayName || S.conn!.username).slice(0, 2).toUpperCase()),
    ),
  );
}

function accountMenu(): Child[] {
  const c = S.conn!;
  const close = () => {
    S.menuOpen = false;
    focusNext("acct");
    render();
  };
  return [
    button({ class: "backdrop", tabindex: "-1", "aria-label": "Close account menu", onClick: close }),
    h(
      "div",
      {
        class: "menu",
        role: "menu",
        "aria-label": "Account",
        onKeydown: (e: KeyboardEvent) => {
          if (e.key === "Escape") {
            e.preventDefault();
            close();
          } else listKeys(e);
        },
      },
      h("div", { class: "mid" }, h("span", { class: "av lg" }, (c.displayName || c.username).slice(0, 2).toUpperCase()), h("div", { style: "min-width:0" }, h("div", { class: "b trunc" }, c.displayName || c.username), h("div", { class: "mut sm" }, `@${c.username}`))),
      h("div", { class: "mrow sm" }, h("span", { class: "dot", "aria-hidden": "true" }), h("span", null, "Connected to"), h("span", { class: "mono trunc" }, host(c.origin))),
      h("div", { class: "mrow xs" }, c.canWrite ? "Can browse and publish reviews" : "Read-only: browsing only"),
      h("div", { class: "sep" }),
      button({ role: "menuitem", class: "mi", "data-nav": "1", "data-fk": "menu-first", onClick: () => ((S.menuOpen = false), openRepos()) }, icon("repo", "s mut"), "Switch repository"),
      button({ role: "menuitem", class: "mi", "data-nav": "1", onClick: signOut }, icon("logout", "s mut"), "Sign out"),
      h("p", { class: "mfine" }, `Signing out revokes this session, removes it from Orca’s vault, and clears review drafts and cached data for @${c.username}. To use another server, sign out first.`),
      h("details", { class: "diag", style: "padding:0 8px 6px" }, h("summary", null, "Connect a coding agent"), h("p", { class: "mcp" }, `MCP endpoint: ${c.mcpUrl} (Streamable HTTP, bearer token). Agent setup is separate from this plugin.`)),
    ),
  ];
}

// ───────────────────────── auth ─────────────────────────
function brand() {
  return h("div", { class: "brand" }, h("span", { class: "logo", style: `mask-image:url('${logoUrl}');-webkit-mask-image:url('${logoUrl}')`, "aria-hidden": "true" }), h("span", null, "CV Hub"), h("span", { class: "mut xs", style: "font-weight:400" }, "for Orca"));
}
function authScreen() {
  const a = S.attempt;
  const box = h("div", { class: "abox" }, brand());
  const wrap = h("div", { class: `auth ${S.wide ? "wide" : ""}` }, box);
  if (S.conn?.expired) {
    add(box, 
      h(
        "div",
        { class: "fail", role: "alert" },
        h("div", { class: "fi warn" }, icon("lock")),
        h("h2", { class: "h2" }, "Your CV Hub session ended"),
        h("p", { class: "lead" }, `Orca couldn’t refresh your sign-in to ${host(S.conn.origin)}. Sign in again to pick up where you left off — your repository, selection and review drafts are kept.`),
        h("div", { class: "r2" }, button({ class: "btn pri", "data-fk": "failp", onClick: () => startSignIn(S.conn!.origin) }, "Sign in again"), button({ class: "btn", onClick: signOut }, "Sign out")),
      ),
    );
    return wrap;
  }
  if (a && a.phase === "pending") {
    const remaining = Math.max(0, a.expiresAt - Date.now());
    const mm = Math.floor(remaining / 60000);
    const ss = String(Math.floor((remaining % 60000) / 1000)).padStart(2, "0");
    const at = new Date(a.expiresAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    const manual = ["unavailable", "unverified"].includes(a.browser);
    const BROWSER_NOTE: Partial<Record<Attempt["browser"], [("" | "warn" | "ok"), IconName, string]>> = {
      confirming: ["", "info", "Confirm in Orca’s dialog to open your browser. Orca shows the server and the exact address first."],
      opened: ["ok", "check", "Browser opened. Approve the request there; this panel continues on its own."],
      declined: ["warn", "info", a.browserMessage ?? ""],
      rate_limited: ["warn", "info", a.browserMessage ?? ""],
      invalidated: ["warn", "warn", a.browserMessage ?? ""],
      unavailable: ["warn", "warn", a.browserMessage ?? ""],
      unverified: ["warn", "warn", a.browserMessage ?? ""],
    };
    const bn = BROWSER_NOTE[a.browser];
    add(
      box,
      h("div", { style: "display:flex;flex-direction:column;gap:6px" }, h("h2", { class: "h2" }, "Enter this code in your browser"), h("p", { class: "lead" }, "CV Hub will ask you to confirm it matches the code shown here. Approval happens in the browser; this panel continues on its own.")),
      h("div", { class: "code codebox", id: "user-code", "aria-label": `Verification code ${a.userCode.split("").join(" ")}` }, a.userCode),
      h(
        "div",
        { class: "r2 fill" },
        button({ class: "btn", "data-fk": "copy", onClick: () => copyText(a.userCode, "user-code", "Code") }, icon(S.auth.copied === "Code" ? "check" : "copy", "s"), S.auth.copied === "Code" ? "Copied" : "Copy code"),
        manual
          ? null
          : button(
              { class: "btn pri", "data-fk": "continue", disabled: a.browser === "confirming", "aria-busy": String(a.browser === "confirming"), onClick: continueInBrowser },
              a.browser === "confirming" ? spinner() : icon("external", "s"),
              a.browser === "opened" || a.browser === "declined" || a.browser === "invalidated" ? "Open browser again" : "Continue in browser",
            ),
      ),
      bn ? note(bn[0], bn[1], bn[2]) : null,
      h(
        "div",
        { style: "display:flex;flex-direction:column;gap:4px" },
        h("span", { class: "lbl" }, manual ? "Open this address in your browser" : "Or open this address yourself"),
        h("div", { class: "urlbox", id: "verify-url" }, a.verificationUri),
        button({ class: "linkbtn", style: "align-self:flex-start", onClick: () => copyText(a.verificationUri, "verify-url", "Address") }, icon(S.auth.copied === "Address" ? "check" : "copy", "s"), S.auth.copied === "Address" ? "Copied" : "Copy address"),
      ),
      h("p", { class: "fine" }, `The code expires in ${mm}:${ss} (at ${at}).`),
      h("div", { class: "wait" }, spinner(), h("div", { class: "fine" }, `Waiting for approval as you sign in to ${host(a.origin)}…`)),
      button({ class: "btn ghost", style: "align-self:flex-start", onClick: cancelSignIn }, "Cancel"),
    );
    return wrap;
  }
  const fail = a && a.phase !== "connected" ? a.phase : S.auth.error ? (S.auth.error.code as string) : null;
  const FAIL: Record<string, { title: string; text: string; p: string; tone?: string }> = {
    denied: { title: "Access was denied", text: "The sign-in request was declined in the browser. Nothing was stored in Orca.", p: "Try again" },
    expired: { title: "The code expired", text: "Verification codes are valid for a limited time. Request a new code to continue.", p: "Get a new code", tone: "warn" },
    offline: { title: `Can’t reach ${host(S.auth.server)}`, text: "Orca couldn’t connect to the CV Hub server. Check the address and your network connection, then try again.", p: "Try again" },
    invalid_client: { title: "This server can’t sign in the plugin", text: "CV Hub doesn’t recognise the sign-in client the plugin uses (cv-git-cli). An administrator needs to check the server’s OAuth clients.", p: "Try again" },
    invalid_origin: { title: "Check the server address", text: S.auth.error?.message ?? "", p: "Try again" },
    interrupted: { title: "Sign-in was interrupted", text: "Orca restarted or updated the plugin while you were signing in, which ends the request. Start again to get a new code.", p: "Start again", tone: "warn" },
    host_unsupported: { title: "This Orca build is too old for CV Hub", text: "The plugin needs Orca’s explicit panel-command, native review and browser-authorization host (lamtuanvu/orca 75b02825 or later). Update Orca, then reopen this panel.", p: "Retry", tone: "warn" },
    error: { title: "Sign-in didn’t finish", text: a?.message ?? S.auth.error?.message ?? "CV Hub returned an unexpected response.", p: "Try again" },
  };
  if (fail) {
    const f = FAIL[fail!] ?? FAIL.error;
    add(box, 
      h(
        "div",
        { class: "fail", role: "alert" },
        h("div", { class: `fi ${f.tone ?? ""}` }, icon("warn")),
        h("h2", { class: "h2" }, f.title),
        h("p", { class: "lead" }, f.text),
        h(
          "div",
          { class: "r2" },
          button({ class: "btn pri", "data-fk": "failp", onClick: () => startSignIn(S.auth.server) }, f.p),
          button({ class: "btn", onClick: () => ((S.attempt = null), (S.auth.error = null), (S.auth.showSettings = true), render()) }, fail === "offline" || fail === "invalid_origin" ? "Edit server address" : "Connection settings"),
        ),
      ),
    );
    return wrap;
  }
  add(box, 
    h("div", { style: "display:flex;flex-direction:column;gap:6px" }, h("h2", { class: "h2" }, S.legacy ? "Sign in again with CV Hub" : "Connect to CV Hub"), h("p", { class: "lead" }, S.legacy ? `This plugin now signs in through your browser instead of a personal access token. Sign in once to replace the saved token for @${S.legacy.username}.` : "Browse repositories, inspect pull requests in Orca’s diff viewer and submit reviews without leaving the editor.")),
    button(
      { class: "btn pri lg block", "data-fk": "signin", disabled: S.auth.busy, "aria-busy": String(S.auth.busy), onClick: () => startSignIn(S.auth.server) },
      S.auth.busy ? spinner() : null,
      S.auth.busy ? "Requesting a code…" : "Sign in with CV Hub",
    ),
    h("p", { class: "fine" }, "You’ll approve access in your browser. The plugin never asks for your CV Hub password or a personal access token."),
    h("details", { class: "diag" }, h("summary", null, "What the plugin asks for"), h("ul", { class: "scopes" }, h("li", null, "profile — your name and username"), h("li", null, "repo:read — list repositories, pull requests, checks and code"), h("li", null, "repo:write — publish pull request reviews (you can approve read-only)"), h("li", null, "offline_access — stay signed in"))),
    settings(),
  );
  return wrap;
}
function settings() {
  const wrap = h("div", { style: "display:flex;flex-direction:column;gap:8px;border-top:1px solid var(--bd2);padding-top:12px" });
  add(wrap, 
    button(
      { class: "linkbtn", style: "align-self:flex-start", "aria-expanded": String(S.auth.showSettings), "aria-controls": "conn", onClick: () => ((S.auth.showSettings = !S.auth.showSettings), render()) },
      icon(S.auth.showSettings ? "expand" : "right", "s"),
      "Connection settings",
    ),
  );
  if (!S.auth.showSettings) {
    add(wrap, h("p", { class: "fine" }, S.auth.server ? ["Server: ", h("span", { class: "mono" }, host(S.auth.server)), S.auth.server === DEFAULT_ORIGIN ? " (CV Hub)" : ""] : "No server set — open Connection settings to add your CV Hub API address."));
    return wrap;
  }
  const input = h("input", {
    id: "srv",
    class: "in plain mono",
    "data-fk": "srv",
    value: S.auth.server,
    placeholder: "https://api.your-cv-hub.example",
    spellcheck: "false",
    autocomplete: "off",
    "aria-invalid": String(!!S.auth.serverError),
    "aria-describedby": "srvh",
    onInput: (e: Event) => {
      S.auth.server = (e.target as HTMLInputElement).value.trim();
      S.auth.serverError = "";
    },
    onKeydown: (e: KeyboardEvent) => {
      if (e.key === "Enter") {
        e.preventDefault();
        startSignIn(S.auth.server);
      }
    },
  });
  add(wrap, 
    h(
      "div",
      { class: "conn", id: "conn" },
      h("label", { class: "lbl", for: "srv" }, "CV Hub API origin"),
      input,
      S.auth.serverError
        ? h("p", { class: "fine bad", id: "srvh" }, icon("warn", "s"), S.auth.serverError)
        : h("p", { class: "fine", id: "srvh" }, `The API origin, not the web app or an /api path. CV Hub is ${DEFAULT_ORIGIN}; for a self-hosted server use its API origin. HTTPS is required except for localhost development, e.g. http://localhost:3001.`),
    ),
  );
  return wrap;
}
let authTimer: ReturnType<typeof setTimeout> | null = null;
function pollAuth(delay = 2000) {
  if (authTimer) clearTimeout(authTimer);
  authTimer = setTimeout(async () => {
    authTimer = null;
    if (!S.attempt || S.attempt.phase !== "pending") return;
    const id = S.attempt.attemptId;
    try {
      const status = statusSchema.parse(await command("authStatus"));
      if (S.attempt?.attemptId !== id) return;
      applyStatus(status);
    } catch {
      /* transient; keep polling */
    }
    if (S.attempt?.phase === "pending") pollAuth();
    render();
  }, delay);
}
function applyStatus(status: z.infer<typeof statusSchema>) {
  const before = S.conn;
  if (S.attempt?.phase === "pending" && !status.attempt && !status.connection) {
    // The worker no longer knows the attempt: Orca restarted or reconciled the plugin.
    S.attempt = null;
    S.auth.error = { code: "interrupted", message: "" };
    say("Sign-in was interrupted. Start again.");
    focusNext("failp");
    return;
  }
  S.legacy = status.legacy;
  S.attempt = status.attempt;
  if (status.attempt?.phase === "connected" && status.connection) {
    const sameAccount = before && before.userId === status.connection.userId && before.origin === status.connection.origin;
    S.conn = status.connection;
    S.attempt = null;
    say(`Signed in to CV Hub as ${status.connection.displayName || status.connection.username}.`);
    if (sameAccount && S.repo) {
      S.screen = "main";
      loadPulls();
      if (S.selected) loadDetail(S.selected);
    } else {
      resetWorkspace();
      openRepos();
    }
    return;
  }
  if (status.attempt && status.attempt.phase !== "pending") {
    const words: Record<string, string> = { denied: "Access was denied in the browser.", expired: "The verification code expired.", invalid_client: "This server isn’t set up for the Orca plugin.", error: "Sign-in didn’t finish." };
    say(words[status.attempt.phase] ?? "");
    focusNext("failp");
  }
  S.conn = status.connection;
}
async function startSignIn(origin: string) {
  S.auth.error = null;
  S.attempt = null;
  if (!origin) {
    S.auth.showSettings = true;
    S.auth.serverError = "Enter your CV Hub API origin first.";
    focusNext("srv");
    return render();
  }
  S.auth.busy = true;
  S.screen = "auth";
  render();
  const id = ++seq.auth;
  try {
    const attempt = attemptSchema.parse(await command("authStart", { origin }));
    if (id !== seq.auth) return;
    S.attempt = attempt;
    S.auth.server = attempt.origin;
    say(`Verification code ${attempt.userCode.split("").join(" ")}. Continue in your browser to approve.`);
    focusNext("continue");
    pollAuth();
  } catch (error) {
    if (id !== seq.auth) return;
    const f = failure(error);
    if (f.code === "invalid_origin") {
      S.auth.showSettings = true;
      S.auth.serverError = f.message;
      focusNext("srv");
    } else S.auth.error = f;
    say(f.message);
  } finally {
    if (id === seq.auth) S.auth.busy = false;
    render();
  }
}
async function continueInBrowser() {
  if (!S.attempt) return;
  try {
    // Returns at once: Orca's native confirmation and the browser outcome arrive via status polling.
    const r = z
      .object({ requested: z.boolean(), browser: z.enum(BROWSER), browserMessage: z.string().nullable() })
      .parse(await command("authOpenVerification", { attemptId: S.attempt.attemptId }));
    S.attempt = { ...S.attempt, browser: r.browser, browserMessage: r.browserMessage };
    say(r.browser === "confirming" ? "Confirm in Orca’s dialog to open your browser." : r.browserMessage ?? "");
    pollAuth(500);
  } catch (error) {
    say(failure(error).message);
  }
  render();
}
async function copyText(text: string, elementId: string, what: "Code" | "Address") {
  try {
    await navigator.clipboard.writeText(text);
    S.auth.copied = what;
    say(`${what} copied.`);
  } catch {
    // The sandbox may block the clipboard: select the text so ⌘C / Ctrl+C works.
    const el = document.getElementById(elementId);
    if (el) getSelection()?.selectAllChildren(el);
    say(`${what} selected. Press Command-C or Control-C to copy.`);
  }
  render();
  setTimeout(() => ((S.auth.copied = ""), render()), 2000);
}
async function cancelSignIn() {
  if (authTimer) clearTimeout(authTimer);
  const id = S.attempt?.attemptId;
  S.attempt = null;
  seq.auth++;
  render();
  await command("authCancel", { attemptId: id }).catch(() => undefined);
  say("Sign-in cancelled.");
  focusNext("signin");
  render();
}
function resetWorkspace() {
  for (const k of Object.keys(seq) as Array<keyof typeof seq>) seq[k]++;
  S.repo = null;
  S.repos = idle({ items: [], total: 0 });
  S.prs = idle({ items: [], total: 0 });
  S.selected = null;
  S.view = "list";
  S.detail = idle(null);
  S.checks = idle({ items: [], total: 0 });
  S.reviews = idle({ items: [], total: 0 });
  S.search = { q: "", lastQ: "", ...idle([]) };
  S.inspected.clear();
  S.drafts.clear();
  S.submits.clear();
  S.notice = null;
  S.menuOpen = false;
}
async function signOut() {
  const who = S.conn?.username;
  S.menuOpen = false;
  resetWorkspace();
  S.screen = "auth";
  render();
  try {
    const r = z.object({ signedOut: z.boolean(), revoked: z.boolean() }).parse(await command("disconnect"));
    say(r.revoked ? `Signed out. Drafts and cached data for @${who} were cleared.` : "Signed out on this device. CV Hub couldn’t confirm the session was revoked; you can revoke it under Authorized apps on CV Hub.");
  } catch (error) {
    say(failure(error).message);
  }
  const origin = S.conn?.origin ?? S.auth.server;
  S.conn = null;
  S.legacy = null;
  S.attempt = null;
  S.auth.server = origin;
  focusNext("signin");
  render();
}
/** Any call can discover that the session ended; route to the right auth state. */
async function guard(error: unknown): Promise<Failure> {
  const f = failure(error);
  if (AUTH_CODES.has(f.code)) {
    try {
      applyStatus(statusSchema.parse(await command("authStatus")));
    } catch {
      /* keep the current view */
    }
    if (f.code === "session_expired" && S.conn) S.conn = { ...S.conn, expired: true };
    say(f.message);
    render();
  }
  return f;
}

// ───────────────────────── repositories ─────────────────────────
let repoTimer: ReturnType<typeof setTimeout> | null = null;
async function loadRepos() {
  const id = ++seq.repos;
  S.repos = { ...S.repos, status: "loading" };
  render();
  try {
    const r = repoListSchema.parse(await command("listRepositories", { offset: S.repoOffset, search: S.repoQuery.trim() }));
    if (id !== seq.repos) return;
    S.repos = { status: "ready", data: { items: r.repositories, total: r.total } };
  } catch (error) {
    if (id !== seq.repos) return;
    S.repos = { ...S.repos, status: "error", error: await guard(error) };
  }
  render();
}
function openRepos() {
  S.screen = "repos";
  S.menuOpen = false;
  focusNext("rq");
  if (S.repos.status === "idle") loadRepos();
  render();
}
function selectRepo(r: Repo) {
  if (S.repo && slug(S.repo) === slug(r)) {
    S.screen = "main";
    return render();
  }
  seq.prs++;
  seq.detail++;
  seq.search++;
  S.repo = r;
  S.screen = "main";
  S.tab = "prs";
  S.filter = "open";
  S.prOffset = 0;
  S.selected = null;
  S.view = "list";
  S.detail = idle(null);
  S.notice = null;
  S.search = { q: "", lastQ: "", ...idle([]) };
  say(`Repository ${slug(r)} selected.`);
  loadPulls();
}
function reposScreen() {
  const d = S.repos;
  const list = h("div", { class: "scroll", "data-sk": "repos" });
  if (d.status === "loading" || d.status === "idle") add(list, skeleton());
  else if (d.status === "error") add(list, h("div", { style: "padding:10px" }, errorNote("Couldn’t load repositories.", d.error!, loadRepos)));
  else if (!d.data.items.length)
    add(list, 
      S.repoQuery
        ? empty("search", `No repositories match “${S.repoQuery}”`, "Search matches owner and repository names.", button({ class: "btn sm", onClick: () => ((S.repoQuery = ""), (S.repoOffset = 0), focusNext("rq"), loadRepos()) }, "Clear search"))
        : empty("repo", "No repositories yet", `Hosted repositories you can access on ${host(S.conn!.origin)} appear here.`),
    );
  else
    add(list, 
      h(
        "ul",
        { class: "ls pad", "aria-label": "Repositories", onKeydown: listKeys },
        d.data.items.map((r) => {
          const sel = S.repo && slug(S.repo) === slug(r);
          return h(
            "li",
            null,
            button(
              { class: `ritem ${sel ? "sel" : ""}`, "aria-current": String(!!sel), "data-nav": "1", "data-fk": `repo:${slug(r)}`, onClick: () => selectRepo(r) },
              icon("repo", "mut"),
              h("span", { style: "min-width:0;flex:1" }, h("span", { class: "rn" }, h("span", { class: "mut" }, `${r.owner} / `), h("span", { class: "b" }, r.repo))),
              sel ? icon("check") : null,
            ),
          );
        }),
      ),
    );
  const pager =
    d.status === "ready" && d.data.total > PAGE
      ? h(
          "div",
          { class: "pager" },
          h("span", { class: "mut sm" }, `${S.repoOffset + 1}–${Math.min(S.repoOffset + PAGE, d.data.total)} of ${d.data.total}`),
          h("div", { class: "g" }, button({ class: "btn sm", disabled: S.repoOffset === 0, "aria-label": "Previous page", onClick: () => ((S.repoOffset -= PAGE), loadRepos()) }, icon("left", "s"), "Prev"), button({ class: "btn sm", disabled: S.repoOffset + PAGE >= d.data.total, "aria-label": "Next page", onClick: () => ((S.repoOffset += PAGE), loadRepos()) }, "Next", icon("right", "s"))),
        )
      : null;
  return h(
    "div",
    { class: "pane" },
    h(
      "div",
      { class: "ph" },
      S.repo ? button({ class: "ib", "aria-label": "Back to pull requests", onClick: () => ((S.screen = "main"), focusNext("rsw"), render()) }, icon("left", "s")) : null,
      h("h2", { class: "h3" }, "Repositories"),
      h("span", { class: "mut sm" }, `on ${host(S.conn!.origin)}`),
    ),
    h(
      "div",
      { class: "sbar" },
      h(
        "div",
        { class: "srch" },
        icon("search", "s"),
        h("label", { class: "sr", for: "rq" }, "Find a repository"),
        h("input", {
          id: "rq",
          class: "in",
          type: "search",
          "data-fk": "rq",
          placeholder: "Find a repository…",
          value: S.repoQuery,
          autocomplete: "off",
          onInput: (e: Event) => {
            S.repoQuery = (e.target as HTMLInputElement).value;
            S.repoOffset = 0;
            if (repoTimer) clearTimeout(repoTimer);
            repoTimer = setTimeout(loadRepos, 250);
          },
          onKeydown: (e: KeyboardEvent) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              view.querySelector<HTMLElement>(".ritem")?.focus();
            } else if (e.key === "Escape" && S.repo) {
              S.screen = "main";
              render();
            }
          },
        }),
      ),
    ),
    list,
    pager,
  );
}

// ───────────────────────── pull requests ─────────────────────────
async function loadPulls() {
  if (!S.repo) return;
  const id = ++seq.prs;
  S.prs = { ...S.prs, status: "loading" };
  render();
  try {
    const r = z.object({ pulls: z.array(pullSummarySchema), total: z.number() }).parse(
      await command("listPulls", { ...S.repo, offset: S.prOffset, state: S.filter === "mine" ? "open" : S.filter, mine: S.filter === "mine" }),
    );
    if (id !== seq.prs) return;
    S.prs = { status: "ready", data: { items: r.pulls, total: r.total } };
    say(r.total ? `${r.total} pull requests.` : "No pull requests.");
  } catch (error) {
    if (id !== seq.prs) return;
    S.prs = { ...S.prs, status: "error", error: await guard(error) };
  }
  render();
}
function selectPull(n: number) {
  if (!S.wide) listScroll = view.querySelector<HTMLElement>('[data-sk="prs"]')?.scrollTop ?? 0;
  const same = S.selected === n && S.detail.data?.number === n;
  S.selected = n;
  S.view = "detail";
  if (!same) {
    S.detailTab = "overview";
    S.notice = null;
    S.viewer = "idle";
    loadDetail(n);
  }
  if (!S.wide) focusNext("back");
  render();
}
function back() {
  const n = S.selected;
  S.view = "list";
  focusNext(`pr:${n}`);
  render();
  requestAnimationFrame(() => {
    const el = view.querySelector<HTMLElement>('[data-sk="prs"]');
    if (el) el.scrollTop = listScroll;
  });
}
async function loadDetail(n: number) {
  const id = ++seq.detail;
  const repo = S.repo!;
  S.detail = { status: "loading", data: S.detail.data?.number === n ? S.detail.data : null };
  render();
  void loadChecks(n, id);
  void loadReviews(n, id);
  try {
    const pull = pullDetailSchema.parse(await command("getPull", { ...repo, number: n }));
    if (id !== seq.detail) return;
    const prev = S.detail.data;
    const insp = S.inspected.get(prKey(n));
    if (prev && prev.number === n && prev.sourceSha && pull.sourceSha && prev.sourceSha !== pull.sourceSha)
      S.notice = { kind: "warn", text: `New commits were pushed to #${n} (${short(prev.sourceSha)} → ${short(pull.sourceSha)}).` };
    else if (insp && pull.sourceSha && insp !== pull.sourceSha)
      S.notice = { kind: "warn", text: `#${n} has new commits since you inspected ${short(insp)}.` };
    S.detail = { status: "ready", data: pull };
    say(`Pull request ${n} loaded.`);
  } catch (error) {
    if (id !== seq.detail) return;
    S.detail = { ...S.detail, status: "error", error: await guard(error) };
  }
  render();
}
async function loadChecks(n = S.selected!, id = seq.detail) {
  S.checks = { ...S.checks, status: "loading" };
  render();
  try {
    const r = checksSchema.parse(await command("getPullChecks", { ...S.repo!, number: n }));
    if (id !== seq.detail) return;
    S.checks = { status: "ready", data: { items: r.checks, total: r.total } };
  } catch (error) {
    if (id !== seq.detail) return;
    S.checks = { ...S.checks, status: "error", error: await guard(error) };
    say("Checks couldn’t be loaded. The pull request is still available.");
  }
  render();
}
async function loadReviews(n = S.selected!, id = seq.detail) {
  S.reviews = { ...S.reviews, status: "loading" };
  render();
  try {
    const r = reviewsSchema.parse(await command("listReviews", { ...S.repo!, number: n }));
    if (id !== seq.detail) return null;
    S.reviews = { status: "ready", data: { items: r.reviews, total: r.total } };
    render();
    return r.reviews;
  } catch (error) {
    if (id !== seq.detail) return null;
    S.reviews = { ...S.reviews, status: "error", error: await guard(error) };
    render();
    return null;
  }
}
function refresh() {
  if (S.screen === "repos") return loadRepos();
  if (S.tab === "prs") {
    loadPulls();
    if (S.selected) loadDetail(S.selected);
  } else if (S.search.lastQ) runSearch(S.search.lastQ);
}
function setFilter(f: Filter) {
  if (f === S.filter) return;
  S.filter = f;
  S.prOffset = 0;
  loadPulls();
}

function mainScreen() {
  const tabs = h(
    "div",
    { class: "tabs", role: "tablist", "aria-label": "CV Hub sections" },
    button({ role: "tab", class: "tab", "aria-selected": String(S.tab === "prs"), onClick: () => ((S.tab = "prs"), render()) }, icon("pr", "s"), "Pull requests"),
    button({ role: "tab", class: "tab", "aria-selected": String(S.tab === "search"), "data-fk": "tab-search", onClick: () => ((S.tab = "search"), focusNext("sq"), render()) }, icon("search", "s"), "Code search"),
  );
  if (S.tab === "search") return h("div", { class: "pane" }, tabs, searchPane());
  const showList = S.wide || S.view === "list" || !S.selected;
  const showDetail = !!S.selected && (S.wide || S.view === "detail");
  return h(
    "div",
    { class: "pane" },
    tabs,
    h(
      "div",
      { class: "split" },
      showList ? listPane() : null,
      showDetail ? detailPane() : null,
      S.wide && !S.selected
        ? h("div", { class: "dempty" }, icon("pr"), h("div", { style: "color:var(--fg);font-weight:600" }, "Select a pull request"), h("div", { class: "sm" }, "Its description, checks and reviews appear here."))
        : null,
    ),
  );
}
function listPane() {
  const FL: Array<[Filter, string]> = [["open", "Open"], ["merged", "Merged"], ["closed", "Closed"], ["all", "All"], ["mine", "My open PRs"]];
  const d = S.prs;
  const body = h("div", { class: "scroll", "data-sk": "prs" });
  if (d.status === "loading" || d.status === "idle") add(body, skeleton());
  else if (d.status === "error")
    add(body, 
      h(
        "div",
        { style: "padding:10px" },
        d.error!.code === "not_found" || d.error!.code === "forbidden"
          ? errorNote(`${slug(S.repo)} is unavailable.`, { code: d.error!.code, message: "It may have been archived or renamed, or your access was removed." }, loadPulls, [button({ class: "btn sm", onClick: openRepos }, "Choose another repository")])
          : errorNote("Couldn’t load pull requests.", d.error!, loadPulls),
      ),
    );
  else if (!d.data.items.length) {
    const copy: Record<Filter, [string, string]> = {
      open: ["No open pull requests", `Nothing is waiting for review in ${slug(S.repo)}.`],
      merged: ["No merged pull requests", "Merged pull requests will show up here."],
      closed: ["No closed pull requests", "Pull requests closed without merging show up here."],
      all: ["No pull requests yet", `Pull requests opened in ${slug(S.repo)} will show up here.`],
      mine: ["You have no open pull requests", `Pull requests you open in ${slug(S.repo)} show up here.`],
    };
    add(body, empty("pr", ...copy[S.filter]));
  } else
    add(body, 
      h(
        "ul",
        { class: "ls pad", "aria-label": `${FL.find((f) => f[0] === S.filter)![1]} pull requests`, onKeydown: listKeys },
        d.data.items.map((p) => {
          const st = prState(p);
          const sel = S.selected === p.number;
          return h(
            "li",
            null,
            button(
              { class: `row ${sel ? "sel" : ""}`, "aria-current": String(sel), "data-nav": "1", "data-fk": `pr:${p.number}`, onClick: () => selectPull(p.number) },
              h("span", { class: `ric st-${st}` }, icon(STATE_ICON[st])),
              h(
                "span",
                { class: "rtx" },
                h("span", { class: "rtitle" }, p.title),
                h("span", { class: "rmeta" }, h("span", { class: `stl st-${st}` }, STATE_LABEL[st]), sep(), h("span", null, `#${p.number}`), sep(), h("span", null, p.author), p.updatedAt ? [sep(), h("span", null, ago(p.updatedAt))] : null),
              ),
            ),
          );
        }),
      ),
    );
  return h(
    "div",
    { class: `lp ${S.wide ? "wide" : "full"}` },
    h("div", { class: "filters", role: "group", "aria-label": "Filter pull requests" }, FL.map(([f, label]) => button({ class: "chip", "aria-pressed": String(S.filter === f), onClick: () => setFilter(f) }, label))),
    body,
    d.status === "ready" && d.data.total > 0
      ? h(
          "div",
          { class: "pager" },
          h("span", { class: "mut sm", "aria-live": "polite" }, `${S.prOffset + 1}–${Math.min(S.prOffset + PAGE, d.data.total)} of ${d.data.total}`),
          h("div", { class: "g" }, button({ class: "btn sm", disabled: S.prOffset === 0, "aria-label": "Previous page", onClick: () => ((S.prOffset -= PAGE), loadPulls()) }, icon("left", "s"), "Prev"), button({ class: "btn sm", disabled: S.prOffset + PAGE >= d.data.total, "aria-label": "Next page", onClick: () => ((S.prOffset += PAGE), loadPulls()) }, "Next", icon("right", "s"))),
        )
      : null,
  );
}

const CHECK_KIND = (c: Check): "ok" | "fail" | "pend" | "skip" => {
  const x = (c.conclusion ?? "").toLowerCase();
  if (["success", "passed"].includes(x)) return "ok";
  if (["failure", "failed", "cancelled", "timed_out", "error"].includes(x)) return "fail";
  if (["skipped", "neutral"].includes(x)) return "skip";
  return ["completed", "success"].includes(c.status.toLowerCase()) ? "ok" : "pend";
};
const CHECK_UI = { ok: ["Passed", "checkCircle"], fail: ["Failed", "cancel"], pend: ["Running", "hourglass"], skip: ["Skipped", "skip"] } as const;
function detailPane() {
  const d = S.detail;
  const pull = d.data && d.data.number === S.selected ? d.data : null;
  const pane = h("div", {
    class: "dp",
    role: "region",
    "aria-label": "Pull request details",
    "data-sk": `detail:${S.selected}`,
    onKeydown: (e: KeyboardEvent) => {
      const t = (e.target as HTMLElement).tagName;
      if (e.key === "Escape" && !S.wide && t !== "TEXTAREA" && t !== "INPUT") {
        e.preventDefault();
        back();
      }
    },
  });
  add(pane, 
    h(
      "div",
      { class: "dbar" },
      !S.wide ? button({ class: "btn ghost sm", "data-fk": "back", "aria-label": "Back to pull requests", onClick: back }, icon("left", "s"), "Pull requests") : null,
      h("span", { class: "mut sm trunc ctx" }, `${slug(S.repo)} · #${S.selected}`),
    ),
  );
  if (!pull && d.status === "error") {
    add(pane, h("div", { style: "padding:10px 12px" }, errorNote(`Couldn’t load pull request #${S.selected}.`, d.error!, () => loadDetail(S.selected!))));
    return pane;
  }
  if (!pull) {
    add(pane, h("div", { style: "padding:10px 12px" }, skeleton(4)));
    return pane;
  }
  const st = prState(pull);
  const key = prKey();
  const insp = S.inspected.get(key);
  const head = pull.sourceSha ?? null;
  const checks = S.checks.data.items.map(CHECK_KIND);
  const nFail = checks.filter((k) => k === "fail").length;
  const nPend = checks.filter((k) => k === "pend").length;
  const nOk = checks.filter((k) => k === "ok").length;
  const nSkip = checks.filter((k) => k === "skip").length;
  const ckSummary = [nFail && `${nFail} failing`, nPend && `${nPend} running`, nOk && `${nOk} passed`, nSkip && `${nSkip} skipped`].filter(Boolean).join(" · ") || "No checks";
  const rv = S.reviews.data.items;
  const nCh = rv.filter((r) => r.state === "changes_requested").length;
  const nAp = rv.filter((r) => r.state === "approved").length;
  const webUrl = pullWebUrl(S.conn!.origin, { ...S.repo!, number: pull.number }, S.conn!.webOrigin);
  add(pane, 
    h(
      "div",
      { class: "dhead" },
      h("h2", { class: "dt" }, pull.title, " ", h("span", { class: "num" }, `#${pull.number}`)),
      h(
        "div",
        { class: "meta" },
        h("span", { class: `pill up st-${st}` }, icon(STATE_ICON[st]), STATE_LABEL[st]),
        S.reviews.status === "ready" ? h("span", { class: `pill ${nCh ? "st-closed" : nAp ? "st-open" : "st-draft"}` }, icon(nCh ? "cancel" : nAp ? "checkCircle" : "comment"), nCh ? "Changes requested" : nAp ? `${nAp} approved` : "No approvals") : null,
        S.checks.status === "ready" && checks.length ? h("span", { class: `pill ${nFail ? "st-closed" : nPend ? "ck-pend" : "st-open"}` }, icon(nFail ? "cancel" : nPend ? "hourglass" : "checkCircle"), nFail ? `${nFail} failing` : nPend ? `${nPend} running` : "Checks passing") : null,
      ),
      h("div", { class: "mut sm" }, [pull.author, pull.updatedAt ? ` · updated ${ago(pull.updatedAt)}` : ""]),
      h("div", { class: "pr-link" },
        h("span", { class: "mut xs" }, "PR on CV Hub"),
        button({ id: "pr-url", class: "linkbtn mono xs url", title: "Open PR on CV Hub", "aria-label": `Open pull request #${pull.number} on CV Hub`, onClick: async (event: Event) => {
          const trigger = event.currentTarget as HTMLButtonElement;
          const ref = { ...S.repo!, number: pull.number };
          const detailId = seq.detail;
          trigger.disabled = true;
          try {
            const result = z.object({ opened: z.boolean() }).parse(await command("openPullRequest", ref));
            if (!result.opened) throw new Error("Browser unavailable");
            say("Opened PR on CV Hub.");
          } catch {
            if (seq.detail === detailId) {
              S.notice = { kind: "warn", text: "Orca couldn’t open the browser. Use Copy PR link to open it yourself. Opening links needs the updated Orca host and browser permission." };
              render();
            }
          } finally {
            trigger.disabled = false;
          }
        } }, webUrl),
        button({ class: "linkbtn", onClick: async () => {
          try {
            await navigator.clipboard.writeText(webUrl);
            say("PR link copied.");
          } catch {
            const el = document.getElementById("pr-url");
            if (el) getSelection()?.selectAllChildren(el);
            say("PR link selected. Press Command-C or Control-C to copy.");
          }
        } }, icon("copy", "s"), "Copy PR link"),
      ),
      h("div", { class: "br mono", "aria-label": `Merging ${pull.sourceBranch} into ${pull.targetBranch}` }, h("span", { class: "bch head", title: pull.sourceBranch }, pull.sourceBranch), icon("arrow", "s mut"), h("span", { class: "bch" }, pull.targetBranch)),
    ),
  );
  if (S.notice)
    add(pane, h("div", { class: "noticebox" }, note(S.notice.kind, S.notice.kind === "ok" ? "check" : "warn", S.notice.text, [button({ class: "btn sm ghost", "aria-label": "Dismiss notice", onClick: () => ((S.notice = null), render()) }, "Dismiss")])));
  const inspLine = !insp
    ? h("div", { class: "insp sm", id: "insp" }, icon("circle", "s mut"), h("span", { class: "mut" }, "Not inspected yet — opens this revision in Orca’s diff viewer."))
    : head && insp !== head
      ? h("div", { class: "insp sm warn", id: "insp" }, icon("warn", "s"), `You inspected ${short(insp)}. The pull request has new commits.`)
      : h("div", { class: "insp sm ok", id: "insp" }, icon("check", "s"), `Inspected revision ${short(insp)} in Orca`);
  add(pane, 
    h(
      "div",
      { class: "openbox" },
      button(
        { class: "btn pri lg block", "data-fk": "open", disabled: S.viewer === "opening", "aria-busy": String(S.viewer === "opening"), "aria-describedby": "insp", onClick: openChanges },
        S.viewer === "opening" ? spinner() : icon("diff", "s"),
        S.viewer === "opening" ? "Opening in Orca…" : "Open changes in Orca",
      ),
      head ? h("div", { class: "osum sm" }, h("span", { class: "mono mut" }, `head ${short(head)}`)) : null,
      inspLine,
      S.viewer === "error" ? errorNote("Orca couldn’t open the review.", S.viewerError!, openChanges) : null,
    ),
  );
  const TABS: Array<[typeof S.detailTab, string, string, string]> = [
    ["overview", "Overview", "", ""],
    ["checks", "Checks", S.checks.status === "error" ? "!" : S.checks.status === "ready" ? (nFail ? `${nFail} failing` : String(S.checks.data.total)) : "", S.checks.status === "error" || nFail ? "bad" : ""],
    ["reviews", "Reviews", S.reviews.status === "ready" ? String(S.reviews.data.total) : "", ""],
  ];
  add(pane, 
    h(
      "div",
      {
        class: "dtabs",
        role: "tablist",
        "aria-label": "Pull request sections",
        onKeydown: (e: KeyboardEvent) => {
          const order = TABS.map((t) => t[0]);
          let i = order.indexOf(S.detailTab);
          if (e.key === "ArrowRight") i = (i + 1) % 3;
          else if (e.key === "ArrowLeft") i = (i + 2) % 3;
          else return;
          e.preventDefault();
          S.detailTab = order[i];
          focusNext(`tab:${order[i]}`);
          render();
        },
      },
      TABS.map(([k, label, badge, cls]) =>
        button(
          { role: "tab", class: "tab", id: `t-${k}`, "aria-selected": String(S.detailTab === k), "aria-controls": "tp", tabindex: S.detailTab === k ? "0" : "-1", "data-fk": `tab:${k}`, onClick: () => ((S.detailTab = k), render()) },
          label,
          badge ? h("span", { class: `ct ${cls}` }, badge) : null,
        ),
      ),
    ),
  );
  const tp = h("div", { class: "tp", role: "tabpanel", id: "tp", "aria-labelledby": `t-${S.detailTab}` });
  if (S.detailTab === "overview") {
    add(tp, 
      h(
        "div",
        { class: "mgrid" },
        h("span", { class: "k" }, "Author"),
        h("span", null, pull.author),
        pull.createdAt ? [h("span", { class: "k" }, "Opened"), h("span", null, ago(pull.createdAt))] : null,
        h("span", { class: "k" }, "Checks"),
        h(
          "span",
          { style: "display:flex;gap:6px;flex-wrap:wrap;align-items:center" },
          S.checks.status === "error"
            ? [h("span", { class: "mut" }, "Unavailable"), button({ class: "linkbtn", onClick: () => loadChecks() }, "Retry")]
            : S.checks.status === "ready"
              ? [h("span", { class: nFail ? "ck-fail" : nPend ? "ck-pend" : "ck-ok" }, ckSummary), button({ class: "linkbtn", onClick: () => ((S.detailTab = "checks"), render()) }, "View")]
              : h("span", { class: "mut" }, "Loading…"),
        ),
        h("span", { class: "k" }, "Reviews"),
        h("span", { style: "display:flex;gap:6px;flex-wrap:wrap;align-items:center" }, S.reviews.status === "ready" ? `${S.reviews.data.total} review${S.reviews.data.total === 1 ? "" : "s"}` : S.reviews.status === "error" ? "Unavailable" : "Loading…", button({ class: "linkbtn", onClick: () => ((S.detailTab = "reviews"), focusNext("ta"), render()) }, "Write review")),
      ),
      h("div", { style: "border-top:1px solid var(--bd2);padding-top:12px" }, pull.body ? markdown(pull.body) : h("p", { class: "mut" }, "No description provided.")),
    );
  } else if (S.detailTab === "checks") {
    if (S.checks.status === "error")
      add(tp, errorNote("Couldn’t load checks.", S.checks.error!, () => loadChecks(), []), h("p", { class: "mut sm", style: "margin:0" }, "The rest of this pull request is still up to date."));
    else if (S.checks.status !== "ready") add(tp, skeleton(3));
    else {
      add(tp, h("div", { class: "shd" }, h("span", { class: `${nFail ? "ck-fail" : nPend ? "ck-pend" : "ck-ok"} b` }, ckSummary), head ? h("span", { class: "mut xs mono" }, `on ${short(head)}`) : null));
      if (!S.checks.data.items.length) add(tp, h("p", { class: "mut sm", style: "margin:0" }, "No checks have run for this pull request."));
      add(tp, 
        h(
          "ul",
          { class: "ls", "aria-label": "Checks" },
          S.checks.data.items.map((c) => {
            const k = CHECK_KIND(c);
            return h(
              "li",
              { class: "ck" },
              h("span", { class: `ck-${k}`, style: "display:flex;padding-top:1px" }, icon(CHECK_UI[k][1])),
              h("div", { class: "t" }, h("div", { class: "b trunc" }, c.name), h("div", { class: "mut sm" }, c.durationMs ? `${Math.round(c.durationMs / 1000)} s` : c.status)),
              h("span", { class: `ckl ck-${k}` }, CHECK_UI[k][0]),
            );
          }),
        ),
      );
      if (S.checks.data.total > S.checks.data.items.length) add(tp, h("p", { class: "mut xs", style: "margin:0" }, `Showing ${S.checks.data.items.length} of ${S.checks.data.total}.`));
    }
  } else add(tp, reviewsTab(pull, key, insp, head));
  add(pane, tp);
  return pane;
}

// ───────────────────────── native diff handoff ─────────────────────────
async function openChanges() {
  const pull = S.detail.data;
  if (!pull || !S.repo) return;
  const key = prKey(pull.number);
  const id = seq.detail;
  S.viewer = "opening";
  say("Opening changes in Orca…");
  render();
  try {
    const opened = z.object({ reviewId: z.string(), revision: z.string() }).parse(
      await hostCall("diffs.openReview", { providerId: "cvhub.pullRequest", args: { owner: S.repo.owner, repo: S.repo.repo, number: pull.number } }),
    );
    if (id !== seq.detail) return;
    // The revision Orca actually opened is what the review will be tied to.
    S.inspected.set(key, opened.revision);
    S.viewer = "idle";
    const sub = S.submits.get(key);
    if (sub?.status === "stale") S.submits.delete(key);
    S.notice = { kind: "ok", text: `Opened revision ${short(opened.revision)} in Orca’s review viewer. Close it to come back and submit your review for this revision.` };
    if (pull.sourceSha && pull.sourceSha !== opened.revision) void loadDetail(pull.number);
    say(`Revision ${short(opened.revision)} opened in Orca.`);
  } catch (error) {
    if (id !== seq.detail) return;
    S.viewer = "error";
    S.viewerError = hostFailure(await guard(error));
  }
  focusNext("open");
  render();
}

// ───────────────────────── review composer ─────────────────────────
const KINDS: Array<[Kind, string, string]> = [
  ["commented", "Comment", "General feedback, no verdict"],
  ["approved", "Approve", "These changes are ready to merge"],
  ["changes_requested", "Request changes", "Must be addressed before merging"],
];
const VERDICT: Record<string, [string, "ap" | "ch" | "cm", IconName]> = {
  approved: ["approved", "ap", "checkCircle"],
  changes_requested: ["requested changes", "ch", "cancel"],
  commented: ["commented", "cm", "comment"],
  dismissed: ["review dismissed", "cm", "skip"],
  pending: ["pending review", "cm", "comment"],
};
function reviewsTab(pull: PullDetail, key: string, insp: string | undefined, head: string | null) {
  const out = h("div", { class: "sect" });
  add(out, h("div", { class: "shd" }, h("h3", { class: "h3" }, "Review history"), button({ class: "linkbtn", onClick: () => loadReviews() }, "Reload")));
  if (S.reviews.status === "error") add(out, errorNote("Couldn’t load review history.", S.reviews.error!, () => loadReviews()));
  else if (S.reviews.status !== "ready") add(out, skeleton(2));
  else if (!S.reviews.data.items.length) add(out, h("p", { class: "mut sm", style: "margin:0" }, "No reviews yet."));
  else
    add(out, 
      h(
        "ul",
        { class: "ls", "aria-label": "Reviews" },
        S.reviews.data.items.map((r) => {
          const [label, cls, ic] = VERDICT[r.state] ?? VERDICT.commented;
          const who = r.reviewer ?? "Reviewer";
          return h(
            "li",
            { class: "rv" },
            h("span", { class: "av" }, who.slice(0, 2).toUpperCase()),
            h(
              "div",
              { class: "t" },
              h("div", { class: "rvh" }, h("span", { class: "b" }, who), h("span", { class: `rvk ${cls}` }, icon(ic, "s"), label), r.submittedAt || r.createdAt ? h("span", { class: "mut sm" }, `· ${ago(r.submittedAt ?? r.createdAt)}`) : null, r.commitSha ? [h("span", { class: "mut sm" }, "· on"), h("span", { class: "mono sm mut" }, short(r.commitSha))] : null, r.commitSha && head && r.commitSha !== head ? h("span", { class: "old" }, "older revision") : null),
              r.body ? h("div", { class: "rvb" }, markdown(r.body)) : null,
            ),
          );
        }),
      ),
    );
  add(out, composer(pull, key, insp, head));
  return out;
}
function composer(pull: PullDetail, key: string, insp: string | undefined, head: string | null) {
  const selfReview = pull.author === S.conn?.username;
  const approvalLabel = selfReview ? "Self approve" : "Approve";
  const draft = S.drafts.get(key) ?? { kind: "commented", body: "" };
  const sub = S.submits.get(key) ?? { status: "idle" };
  const canWrite = pull.canWrite && S.conn?.canWrite === true;
  const open = pull.state === "open" || pull.state === "draft";
  const gate = !insp ? "need" : head && insp !== head ? "stale" : "ready";
  const section = h("section", { class: "cmp", "aria-labelledby": "cmph" }, h("div", { class: "cmph" }, h("h3", { class: "h3", id: "cmph" }, "Your review"), h("span", { class: "mut xs", id: "draftnote" }, draft.body.trim() ? "Draft saved" : "")));
  if (!canWrite) {
    add(section, note("", "lock", [h("b", null, "Read-only access."), ` This sign-in can view ${slug(S.repo)}, but publishing a review needs the repo:write permission and write access to the repository. Sign out and sign in again to grant it, or ask a repository admin.`]));
    return section;
  }
  if (!open) {
    add(section, note("", "lock", `This pull request is ${STATE_LABEL[prState(pull)].toLowerCase()}. New reviews can’t be submitted.`));
    return section;
  }
  if (gate === "need") add(section, note("warn", "diff", [h("b", null, "Inspect the changes first."), ` A review is tied to the revision you inspected. Open ${head ? short(head) : "this pull request"} in Orca before submitting — you can write your draft now.`], [button({ class: "btn sm", onClick: openChanges }, "Open changes in Orca")]));
  else if (gate === "stale") add(section, note("warn", "warn", [h("b", null, "New commits since you inspected."), ` You inspected ${short(insp)}; the pull request is now at ${short(head)}. Review the new revision before submitting. Your draft is kept.`], [button({ class: "btn sm", onClick: openChanges }, "Review new revision")]));
  else add(section, h("div", { class: "gate sm" }, icon("check", "s"), h("span", null, `Reviewing revision ${short(insp)} · inspected in Orca`)));
  add(section, 
    h(
      "fieldset",
      { class: `kinds ${S.wide ? "wide" : ""}` },
      h("legend", { class: "sr" }, "Review type"),
      KINDS.map(([k, label, desc]) =>
        h(
          "label",
          { class: `opt ${draft.kind === k ? "on" : ""}` },
          h("input", { type: "radio", name: "kind", value: k, checked: draft.kind === k, onChange: () => (S.drafts.set(key, { ...draft, kind: k }), render()) }),
          h("span", null, h("span", { class: "b" }, k === "approved" ? approvalLabel : label), h("span", { class: "mut xs d" }, k === "approved" && selfReview ? "Approve your own pull request" : desc)),
        ),
      ),
    ),
  );
  const needsBody = draft.kind !== "approved" && !draft.body.trim();
  const blocked = sub.status === "uncertain" || sub.status === "checking";
  const why = () => {
    const d = S.drafts.get(key) ?? draft;
    const nb = d.kind !== "approved" && !d.body.trim();
    return gate === "need" ? "Inspect the changes in Orca to enable submitting." : gate === "stale" ? "Review the new revision to enable submitting." : sub.status === "stale" ? "Inspect the latest revision to enable submitting." : blocked ? "Reload the review history before retrying." : nb ? (d.kind === "changes_requested" ? "Explain what needs to change." : "Write a comment to submit.") : sub.status === "submitting" ? "Submitting…" : `Submits to revision ${short(insp)}.`;
  };
  const disabled = () => {
    const d = S.drafts.get(key) ?? draft;
    return gate !== "ready" || sub.status === "stale" || blocked || sub.status === "submitting" || (d.kind !== "approved" && !d.body.trim());
  };
  const whyEl = h("span", { class: "mut xs", id: "why" }, why());
  const submitBtn = button(
    { class: "btn pri", "data-fk": "submit", disabled: disabled(), "aria-busy": String(sub.status === "submitting"), "aria-describedby": "why", onClick: () => submit(key) },
    sub.status === "submitting" ? spinner() : null,
    sub.status === "submitting" ? "Submitting…" : { commented: "Submit comment", approved: approvalLabel, changes_requested: "Request changes" }[draft.kind],
  );
  const ta = h("textarea", {
    id: "ta",
    class: "ta",
    "data-fk": "ta",
    value: draft.body,
    disabled: sub.status === "submitting",
    placeholder: draft.kind === "changes_requested" ? "What needs to change before this can merge?" : draft.kind === "approved" ? "Anything to add? (optional)" : "Leave a comment on this pull request",
    "aria-describedby": "why",
    maxlength: "12000",
    // Typing updates state and the dependent controls in place: no re-render, no lost caret.
    onInput: (e: Event) => {
      const body = (e.target as HTMLTextAreaElement).value;
      S.drafts.set(key, { ...(S.drafts.get(key) ?? draft), body });
      if (sub.status === "ok" || sub.status === "verified") S.submits.delete(key);
      whyEl.textContent = why();
      submitBtn.disabled = disabled();
      const dn = view.querySelector("#draftnote");
      if (dn) dn.textContent = body.trim() ? "Draft saved" : "";
    },
  });
  add(section, 
    h("div", { style: "display:flex;flex-direction:column;gap:4px" }, h("label", { class: "lbl", for: "ta" }, draft.kind === "approved" ? "Summary (optional)" : "Summary"), ta, h("span", { class: "mut xs" }, "Markdown supported. Drafts stay in this panel for this account until you submit or sign out; they aren’t saved to disk.")),
  );
  if (sub.status === "ok") add(section, note("ok", "check", [h("b", null, "Review submitted."), ` ${sub.text ?? ""}`]));
  if (sub.status === "error") add(section, note("err", "warn", [h("b", null, "Couldn’t submit your review."), ` ${sub.text ?? ""} Nothing was recorded and your draft is kept.`], [button({ class: "btn sm", onClick: () => submit(key) }, "Retry")]));
  if (sub.status === "stale") add(section, note("warn", "warn", [h("b", null, "The pull request moved on."), " CV Hub rejected the review because the revision you inspected is no longer the head. Inspect the new revision, then submit. Your draft is kept."], [button({ class: "btn sm", onClick: openChanges }, "Review new revision")]));
  if (sub.status === "uncertain") add(section, note("warn", "warn", [h("b", null, "We couldn’t confirm your review."), " The connection dropped before CV Hub replied, so it may already be recorded. Reload the history before retrying to avoid a duplicate."], [button({ class: "btn sm", "data-fk": "verify", onClick: () => verifyHistory(key) }, "Reload review history")]));
  if (sub.status === "checking") add(section, note("", "refresh", "Checking review history for your review…"));
  if (sub.status === "verified") add(section, note("", "info", [h("b", null, "Not in the history"), " — the review wasn’t recorded. Your draft is intact; it’s safe to submit again."]));
  add(section, h("div", { class: "cact" }, whyEl, submitBtn));
  return section;
}
async function submit(key: string) {
  const pull = S.detail.data;
  const insp = S.inspected.get(key);
  const draft = S.drafts.get(key) ?? { kind: "commented" as Kind, body: "" };
  if (!pull || !S.repo || !insp) return;
  const id = ++seq.submit;
  S.submits.set(key, { status: "submitting" });
  say("Submitting review…");
  render();
  const reviewsBefore = S.reviews.data.items.map((r) => r.id);
  try {
    await command("submitReview", { ...S.repo, number: pull.number, expectedHeadSha: insp, state: draft.kind, body: draft.body });
    if (id !== seq.submit) return;
    const verb = { commented: "Commented on", approved: "Approved", changes_requested: "Requested changes on" }[draft.kind];
    S.drafts.delete(key);
    S.submits.set(key, { status: "ok", text: `${verb} revision ${short(insp)}. It’s now in the history above.` });
    say("Review submitted.");
    void loadReviews();
  } catch (error) {
    if (id !== seq.submit) return;
    const f = await guard(error);
    if (f.code === "outcome_unknown") {
      S.submits.set(key, { status: "uncertain", text: reviewsBefore.join(",") });
      say("We couldn’t confirm whether your review was recorded. Reload the review history before retrying.");
      focusNext("verify");
    } else if (f.code === "stale_revision") {
      S.submits.set(key, { status: "stale" });
      void loadDetail(pull.number);
    } else S.submits.set(key, { status: "error", text: f.message });
  }
  render();
}
async function verifyHistory(key: string) {
  const before = new Set((S.submits.get(key)?.text ?? "").split(",").filter(Boolean));
  S.submits.set(key, { status: "checking" });
  render();
  const list = await loadReviews();
  if (!list) {
    S.submits.set(key, { status: "uncertain", text: [...before].join(",") });
    return render();
  }
  const mine = list.find((r) => !before.has(r.id) && r.reviewer === S.conn?.username);
  if (mine) {
    S.drafts.delete(key);
    S.submits.set(key, { status: "ok", text: "It was recorded before the connection dropped." });
    say("Your review was already recorded.");
  } else {
    S.submits.set(key, { status: "verified" });
    say("Your review is not in the history. It is safe to submit again.");
    focusNext("submit");
  }
  render();
}

// ───────────────────────── code search ─────────────────────────
async function runSearch(q = S.search.q) {
  q = q.trim();
  if (!q || !S.repo) return;
  const id = ++seq.search;
  S.search = { ...S.search, q, status: "loading" };
  render();
  try {
    const { results } = searchResultsSchema.parse(await command("searchCode", { ...S.repo, query: q }));
    if (id !== seq.search) return;
    S.search = { q, lastQ: q, status: "ready", data: results };
    say(results.length ? `${results.length} results for ${q}` : `No results for ${q}`);
  } catch (error) {
    if (id !== seq.search) return;
    S.search = { ...S.search, lastQ: q, status: "error", error: await guard(error) };
  }
  render();
}
function highlight(line: string, q: string): Child[] {
  const i = q ? line.toLowerCase().indexOf(q.toLowerCase()) : -1;
  return i < 0 ? [line] : [line.slice(0, i), h("mark", null, line.slice(i, i + q.length)), line.slice(i + q.length)];
}
function searchPane() {
  const sr = S.search;
  const body = h("div", { class: "scroll", "data-sk": "search", style: "border-top:1px solid var(--bd2)" });
  if (sr.status === "idle")
    add(body, empty("search", "Search this repository", "Find code by text, symbol or meaning. Press Enter to search.", h("div", { class: "sugg" }, ["Where are reviews submitted?", "slow_down"].map((q) => button({ class: "chip", onClick: () => ((S.search.q = q), runSearch(q)) }, q)))));
  else if (sr.status === "loading") add(body, skeleton(3));
  else if (sr.status === "error")
    add(body, h("div", { style: "padding:10px" }, errorNote(sr.error!.code === "offline" || sr.error!.code === "server_error" ? "Code search is unavailable." : "Code search failed.", sr.error!, () => runSearch(sr.lastQ), [h("span", { class: "mut xs" }, "Pull requests and reviews still work.")])));
  else if (!sr.data.length) add(body, empty("search", `No results for “${sr.lastQ}”`, `Search covers ${slug(S.repo)}. Try a shorter query or a symbol name.`));
  else {
    add(body, h("div", { class: "mut xs", style: "padding:8px 10px 0" }, `${sr.data.length} result${sr.data.length === 1 ? "" : "s"} for “${sr.lastQ}”`));
    add(body, 
      h(
        "ul",
        { class: "ls", "aria-label": "Search results" },
        sr.data.map((r) => {
          const lines = r.content.split("\n").slice(0, 12);
          const start = r.line ?? 1;
          return h(
            "li",
            { class: "res" },
            h("div", { class: "rpath mono" }, icon("file", "s mut"), h("span", null, r.path)),
            h("div", { class: "mut xs", style: "display:flex;gap:6px;flex-wrap:wrap" }, r.symbol ? [h("span", { class: "mono" }, r.symbol), sep()] : null, h("span", null, r.line ? `line ${r.line}` : "line unknown")),
            h("div", { class: "snip", role: "group", "aria-label": `Code at ${r.path}` }, lines.map((l, i) => h("div", { class: "sl" }, h("span", { class: "ln" }, r.line ? String(start + i) : ""), h("span", null, highlight(l, sr.lastQ))))),
          );
        }),
      ),
    );
  }
  return h(
    "div",
    { class: "pane" },
    h(
      "div",
      { class: "sbar" },
      h(
        "div",
        { class: "srch" },
        icon("search", "s"),
        h("label", { class: "sr", for: "sq" }, `Search code in ${slug(S.repo)}`),
        h("input", {
          id: "sq",
          class: "in",
          type: "search",
          "data-fk": "sq",
          maxlength: "1000",
          placeholder: "Search code, symbols, meaning",
          value: sr.q,
          autocomplete: "off",
          spellcheck: "false",
          onInput: (e: Event) => (S.search.q = (e.target as HTMLInputElement).value),
          onKeydown: (e: KeyboardEvent) => {
            if (e.key === "Enter") {
              e.preventDefault();
              runSearch((e.target as HTMLInputElement).value);
            }
          },
        }),
      ),
      button({ class: "btn", disabled: sr.status === "loading", onClick: () => runSearch() }, "Search"),
    ),
    h("div", { class: "scope mut xs" }, "Scoped to ", h("span", { class: "b", style: "color:var(--fg)" }, slug(S.repo)), " · results are read-only"),
    body,
  );
}

// ───────────────────────── boot ─────────────────────────
watchTheme(app, render);
new ResizeObserver(() => {
  const wide = app.clientWidth >= 640;
  if (wide !== S.wide) {
    S.wide = wide;
    render();
  }
}).observe(app);
setInterval(() => {
  if (S.attempt?.phase === "pending") render(); // countdown
}, 1000);
(async () => {
  try {
    const status = statusSchema.parse(await command("authStatus"));
    S.conn = status.connection;
    S.legacy = status.legacy;
    S.attempt = status.attempt?.phase === "connected" ? null : status.attempt;
    S.auth.server = status.connection?.origin ?? status.attempt?.origin ?? status.legacy?.origin ?? DEFAULT_ORIGIN;
    // A panel reload during sign-in resumes the worker-owned attempt.
    if (S.attempt?.phase === "pending") pollAuth();
    if (S.conn && !S.conn.expired) openRepos();
    else S.screen = "auth";
  } catch (error) {
    // No worker answer at boot usually means Orca refused the panel command outright.
    S.auth.error = hostFailure(failure(error));
  }
  S.booted = true;
  render();
})();
