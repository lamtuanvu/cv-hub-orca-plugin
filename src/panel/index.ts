import { h, add, button, type Child } from "./dom";
import { icon, spinner, type IconName } from "./icons";
import { markdown } from "./markdown";
import { watchTheme } from "./theme";
import { renderPatch, fileSummary } from "./diff";
import { req, onPush, openExternal, rememberRepo, recallRepo, failure, type Failure } from "./bridge";
import { DEFAULT_ORIGIN } from "../shared/manifest";
import type {
  AuthAttemptView,
  AuthStatus,
  CheckItem,
  ConnectionView,
  DiffView,
  PullDetail,
  PullSummary,
  RepoRef,
  ReviewItem,
  WorkspaceMatch,
} from "../shared/protocol";
import { pullWebUrl } from "../shared/pull-url";
import logoUrl from "./assets/cv-hub-mono.svg";
import "./style.css";

// ───────────────────────── errors ─────────────────────────
const AUTH_CODES = new Set(["session_expired", "reauth_required", "signed_out"]);

// ───────────────────────── state ─────────────────────────
type Load<T> = { status: "idle" | "loading" | "ready" | "error"; data: T; error?: Failure };
const idle = <T,>(data: T): Load<T> => ({ status: "idle", data });
type Kind = "commented" | "approved" | "changes_requested";
type Draft = { kind: Kind; body: string };
type Submit = { status: "idle" | "submitting" | "ok" | "error" | "uncertain" | "checking" | "verified" | "stale"; text?: string };
type Filter = "open" | "merged" | "closed" | "all" | "mine";
type DetailTab = "overview" | "files" | "checks" | "reviews";
const PAGE = 20;

const S = {
  booted: false,
  wide: false,
  conn: null as ConnectionView | null,
  legacy: null as { origin: string; username: string } | null,
  attempt: null as AuthAttemptView | null,
  /** The API origin a new sign-in would use; set it in Orca's Settings, not here. */
  apiOrigin: DEFAULT_ORIGIN,
  auth: {
    busy: false,
    error: null as Failure | null,
    showServer: false,
    copied: "" as "" | "Code" | "Address",
    /** What the last "Open CV Hub to approve" press did. */
    open: null as { tone: "" | "warn" | "ok"; text: string } | null,
  },
  screen: "auth" as "auth" | "repos" | "main",
  /** The repository detected for Orca's focused workspace. */
  detected: null as RepoRef | null,
  workspaceWhy: "no_workspace" as WorkspaceMatch,
  repos: idle<{ items: RepoRef[]; total: number }>({ items: [], total: 0 }),
  repoQuery: "",
  repoOffset: 0,
  repo: null as RepoRef | null,
  tab: "prs" as "prs" | "search",
  filter: "open" as Filter,
  prOffset: 0,
  prs: idle<{ items: PullSummary[]; total: number }>({ items: [], total: 0 }),
  selected: null as number | null,
  view: "list" as "list" | "detail",
  detail: idle<PullDetail | null>(null),
  checks: idle<{ items: CheckItem[]; total: number }>({ items: [], total: 0 }),
  reviews: idle<{ items: ReviewItem[]; total: number }>({ items: [], total: 0 }),
  detailTab: "overview" as DetailTab,
  /** The Files tab: the pull request's changed files, one patch shown at a time. */
  diff: null as DiffView | null,
  diffKey: null as string | null,
  diffLoad: idle<null>(null),
  diffFile: null as string | null,
  diffSplit: false,
  notice: null as { kind: "ok" | "warn"; text: string } | null,
  inspected: new Map<string, string>(),
  drafts: new Map<string, Draft>(),
  submits: new Map<string, Submit>(),
  search: { q: "", lastQ: "", ...idle<Array<{ path: string; symbol: string; line: number | null; content: string }>>([]) },
  menuOpen: false,
};
const seq = { repos: 0, prs: 0, detail: 0, diff: 0, search: 0, auth: 0 };
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
const slug = (r: RepoRef | null) => (r ? `${r.owner}/${r.repo}` : "");
const sameRepo = (a: RepoRef | null, b: RepoRef | null) =>
  a !== null && b !== null && a.owner.toLowerCase() === b.owner.toLowerCase() && a.repo.toLowerCase() === b.repo.toLowerCase();
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
    const scrolls = new Map<string, [number, number]>();
    view.querySelectorAll<HTMLElement>("[data-sk]").forEach((el) => scrolls.set(el.dataset.sk!, [el.scrollTop, el.scrollLeft]));
    view.replaceChildren();
    add(view, ...screen());
    view.querySelectorAll<HTMLElement>("[data-sk]").forEach((el) => {
      const v = scrolls.get(el.dataset.sk!);
      if (v !== undefined) [el.scrollTop, el.scrollLeft] = v;
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
      r && S.detected && sameRepo(r, S.detected) ? h("span", { class: "badge", title: "Detected from Orca’s focused workspace" }, "Workspace") : null,
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
      h("p", { class: "mfine" }, `Signing out revokes this session, removes it from Orca’s vault, and clears review drafts and cached data for @${c.username}. To use another server, change the CV Hub API origin in Orca’s Settings first.`),
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
    add(
      box,
      h(
        "div",
        { class: "fail", role: "alert" },
        h("div", { class: "fi warn" }, icon("lock")),
        h("h2", { class: "h2" }, "Your CV Hub session ended"),
        h("p", { class: "lead" }, `Orca couldn’t refresh your sign-in to ${host(S.conn.origin)}. Sign in again to pick up where you left off — your repository, selection and review drafts are kept.`),
        h("div", { class: "r2" }, button({ class: "btn pri", "data-fk": "failp", onClick: startSignIn }, "Sign in again"), button({ class: "btn", onClick: signOut }, "Sign out")),
      ),
    );
    return wrap;
  }
  if (a && a.phase === "pending") {
    const remaining = Math.max(0, a.expiresAt - Date.now());
    const mm = Math.floor(remaining / 60000);
    const ss = String(Math.floor((remaining % 60000) / 1000)).padStart(2, "0");
    const at = new Date(a.expiresAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    add(
      box,
      h("div", { style: "display:flex;flex-direction:column;gap:6px" }, h("h2", { class: "h2" }, "Enter this code in your browser"), h("p", { class: "lead" }, "CV Hub will ask you to confirm it matches the code shown here. Approval happens in the browser; this panel continues on its own.")),
      h("div", { class: "code codebox", id: "user-code", "aria-label": `Verification code ${a.userCode.split("").join(" ")}` }, a.userCode),
      h(
        "div",
        { class: "r2 fill" },
        button({ class: "btn", "data-fk": "copy", onClick: () => copyText(a.userCode, "user-code", "Code") }, icon(S.auth.copied === "Code" ? "check" : "copy", "s"), S.auth.copied === "Code" ? "Copied" : "Copy code"),
        // The worker only marks addresses it verified against the server's discovery
        // metadata; anything else is shown for manual navigation, never auto-opened.
        a.verified
          ? button({ class: "btn pri", "data-fk": "continue", onClick: continueInBrowser }, icon("external", "s"), "Open CV Hub to approve")
          : null,
      ),
      a.verified ? null : note("warn", "warn", "Orca couldn’t confirm this address belongs to your CV Hub server, so it won’t offer to open it. Copy the address and open it yourself only if you trust it."),
      S.auth.open ? note(S.auth.open.tone, S.auth.open.tone === "ok" ? "check" : "info", S.auth.open.text) : null,
      h(
        "div",
        { style: "display:flex;flex-direction:column;gap:4px" },
        h("span", { class: "lbl" }, "Or open this address yourself"),
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
    offline: { title: `Can’t reach ${host(S.apiOrigin)}`, text: "Orca couldn’t connect to the CV Hub server. Check the API origin in Orca’s Settings and your network connection, then try again.", p: "Try again" },
    invalid_client: { title: "This server can’t sign in the plugin", text: "CV Hub doesn’t recognise the sign-in client the plugin uses (cv-git-cli). An administrator needs to check the server’s OAuth clients.", p: "Try again" },
    invalid_origin: { title: "Check the server address", text: S.auth.error?.message ?? "", p: "Try again" },
    unsafe_url: { title: "This server can’t be signed in to safely", text: "CV Hub returned a verification address Orca won’t open. An administrator needs to check the server’s OAuth setup.", p: "Try again", tone: "warn" },
    interrupted: { title: "Sign-in was interrupted", text: "The worker restarted while you were signing in, which ends the request. Start again to get a new code.", p: "Start again", tone: "warn" },
    error: { title: "Sign-in didn’t finish", text: a?.message ?? S.auth.error?.message ?? "CV Hub returned an unexpected response.", p: "Try again" },
  };
  if (fail) {
    const f = FAIL[fail!] ?? FAIL.error;
    add(
      box,
      h(
        "div",
        { class: "fail", role: "alert" },
        h("div", { class: `fi ${f.tone ?? ""}` }, icon("warn")),
        h("h2", { class: "h2" }, f.title),
        h("p", { class: "lead" }, f.text),
        h(
          "div",
          { class: "r2" },
          button({ class: "btn pri", "data-fk": "failp", onClick: startSignIn }, f.p),
          button({ class: "btn", onClick: () => ((S.auth.showServer = true), render()) }, "Server settings"),
        ),
      ),
    );
    add(box, serverNote());
    return wrap;
  }
  add(
    box,
    h("div", { style: "display:flex;flex-direction:column;gap:6px" }, h("h2", { class: "h2" }, S.legacy ? "Sign in again with CV Hub" : "Connect to CV Hub"), h("p", { class: "lead" }, S.legacy ? `This plugin now signs in through your browser instead of a personal access token. Sign in once to replace the saved token for @${S.legacy.username}.` : "Browse repositories, inspect pull request changes in the panel, and submit reviews without leaving Orca.")),
    button(
      { class: "btn pri lg block", "data-fk": "signin", disabled: S.auth.busy, "aria-busy": String(S.auth.busy), onClick: startSignIn },
      S.auth.busy ? spinner() : null,
      S.auth.busy ? "Requesting a code…" : "Sign in with CV Hub",
    ),
    h("p", { class: "fine" }, "You’ll approve access in your browser. The plugin never asks for your CV Hub password or a personal access token."),
    h("details", { class: "diag" }, h("summary", null, "What the plugin asks for"), h("ul", { class: "scopes" }, h("li", null, "profile — your name and username"), h("li", null, "repo:read — list repositories, pull requests, checks and code"), h("li", null, "repo:write — publish pull request reviews (you can approve read-only)"), h("li", null, "offline_access — stay signed in"))),
    serverNote(),
  );
  return wrap;
}
/** The server the next sign-in would use, and where it is configured: Orca's own Settings,
 *  not this panel. */
function serverNote() {
  const wrap = h("div", { style: "display:flex;flex-direction:column;gap:8px;border-top:1px solid var(--bd2);padding-top:12px" });
  add(
    wrap,
    button(
      { class: "linkbtn", style: "align-self:flex-start", "aria-expanded": String(S.auth.showServer), onClick: () => ((S.auth.showServer = !S.auth.showServer), render()) },
      icon(S.auth.showServer ? "expand" : "right", "s"),
      "Server",
    ),
  );
  if (!S.auth.showServer) {
    add(wrap, h("p", { class: "fine" }, ["Sign-in uses ", h("span", { class: "mono" }, host(S.apiOrigin)), S.apiOrigin === DEFAULT_ORIGIN ? " (CV Hub)" : ""], ". Change it in Settings → Plugins → CV Hub → CV Hub API origin."));
    return wrap;
  }
  add(
    wrap,
    h(
      "div",
      { class: "conn" },
      h("label", { class: "lbl" }, "CV Hub API origin"),
      h("div", { class: "urlbox mono" }, S.apiOrigin || DEFAULT_ORIGIN),
      h(
        "p",
        { class: "fine" },
        "The API origin, not the web app or an /api path. CV Hub is ",
        h("span", { class: "mono" }, DEFAULT_ORIGIN),
        "; a self-hosted server uses its own. HTTPS is required except for loopback development. Edit it in Orca’s Settings → Plugins → CV Hub; this panel only reads it.",
      ),
    ),
  );
  return wrap;
}
/** Applies a fetched or pushed status. The worker posts `auth.changed` at every phase
 *  change, so this is the only sign-in state machine left. */
function applyStatus(status: AuthStatus) {
  const before = S.conn;
  if (S.attempt?.phase === "pending" && !status.attempt && !status.connection) {
    // The worker no longer knows the attempt: it restarted while we waited.
    S.attempt = null;
    S.auth.error = { code: "interrupted", message: "" };
    say("Sign-in was interrupted. Start again.");
    focusNext("failp");
    return;
  }
  S.legacy = status.legacy;
  S.attempt = status.attempt;
  S.apiOrigin = status.apiOrigin;
  if (status.attempt?.phase === "connected" && status.connection) {
    const sameAccount = before && before.userId === status.connection.userId && before.origin === status.connection.origin;
    S.conn = status.connection;
    S.attempt = null;
    S.auth.open = null;
    say(`Signed in to CV Hub as ${status.connection.displayName || status.connection.username}.`);
    if (sameAccount && S.repo) {
      S.screen = "main";
      loadPulls();
      if (S.selected) loadDetail(S.selected);
    } else {
      resetWorkspace();
      void enterWorkspace();
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
async function startSignIn() {
  S.auth.error = null;
  S.auth.open = null;
  S.attempt = null;
  S.auth.busy = true;
  S.screen = "auth";
  render();
  const id = ++seq.auth;
  try {
    // The worker picks the origin from the apiOrigin setting; the answer paints at once
    // and every later phase change arrives as an auth.changed push.
    const attempt = await req("auth.start", {});
    if (id !== seq.auth) return;
    S.attempt = attempt;
    S.apiOrigin = attempt.origin;
    say(`Verification code ${attempt.userCode.split("").join(" ")}. Continue in your browser to approve.`);
    focusNext("continue");
  } catch (error) {
    if (id !== seq.auth) return;
    const f = failure(error);
    if (f.code === "invalid_origin") S.auth.showServer = true;
    S.auth.error = f;
    say(f.message);
  } finally {
    if (id === seq.auth) S.auth.busy = false;
    render();
  }
}
/** The button press is the user gesture Orca's shell needs to open the browser. */
async function continueInBrowser() {
  const a = S.attempt;
  if (!a || a.phase !== "pending") return;
  if (!a.verified) {
    say("Copy the address below and open it yourself.");
    render();
    return;
  }
  const result = await openExternal(a.verificationUri);
  S.auth.open = result.opened
    ? { tone: "ok", text: "Browser opened. Approve the code on CV Hub; this panel continues on its own." }
    : result.reason === "cancelled"
      ? { tone: "warn", text: "The browser wasn’t opened — the confirmation was cancelled. Open the address below yourself." }
      : { tone: "warn", text: "This client can’t open a browser for you. Copy the address below and open it yourself." };
  say(result.opened ? "Browser opened. Approve the code on CV Hub." : "The browser didn’t open. Copy the address below.");
  render();
}
async function copyText(text: string, elementId: string, what: "Code" | "Address") {
  try {
    await navigator.clipboard.writeText(text);
    S.auth.copied = what;
    say(`${what} copied.`);
  } catch {
    // The frame may block the clipboard: select the text so ⌘C / Ctrl+C works.
    const el = document.getElementById(elementId);
    if (el) getSelection()?.selectAllChildren(el);
    say(`${what} selected. Press Command-C or Control-C to copy.`);
  }
  render();
  setTimeout(() => ((S.auth.copied = ""), render()), 2000);
}
async function cancelSignIn() {
  const id = S.attempt?.attemptId;
  S.attempt = null;
  S.auth.open = null;
  seq.auth++;
  render();
  await req("auth.cancel", { attemptId: id ?? null }).catch(() => undefined);
  say("Sign-in cancelled.");
  focusNext("signin");
  render();
}
function resetWorkspace() {
  for (const k of Object.keys(seq) as Array<keyof typeof seq>) seq[k]++;
  S.repo = null;
  S.detected = null;
  S.repos = idle({ items: [], total: 0 });
  S.prs = idle({ items: [], total: 0 });
  S.selected = null;
  S.view = "list";
  S.detail = idle(null);
  S.checks = idle({ items: [], total: 0 });
  S.reviews = idle({ items: [], total: 0 });
  S.diff = null;
  S.diffKey = null;
  S.diffLoad = idle(null);
  S.diffFile = null;
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
    const r = await req("auth.signOut", {});
    say(r.revoked ? `Signed out. Drafts and cached data for @${who} were cleared.` : "Signed out on this device. CV Hub couldn’t confirm the session was revoked; you can revoke it under Authorized apps on CV Hub.");
  } catch (error) {
    say(failure(error).message);
  }
  S.conn = null;
  S.legacy = null;
  S.attempt = null;
  S.auth.open = null;
  focusNext("signin");
  render();
}
/** Any request can discover that the session ended; route to the right auth state. */
async function guard(error: unknown): Promise<Failure> {
  const f = failure(error);
  if (AUTH_CODES.has(f.code)) {
    try {
      applyStatus(await req("auth.status", {}));
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
    const r = await req("repos.list", { offset: S.repoOffset, search: S.repoQuery.trim() });
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
function selectRepo(r: RepoRef, remember = true) {
  if (remember && S.conn) void rememberRepo({ origin: S.conn.origin, userId: S.conn.userId, owner: r.owner, repo: r.repo });
  if (S.repo && sameRepo(S.repo, r)) {
    S.screen = "main";
    return render();
  }
  seq.prs++;
  seq.detail++;
  seq.diff++;
  S.repo = r;
  S.screen = "main";
  S.tab = "prs";
  S.filter = "open";
  S.prOffset = 0;
  S.selected = null;
  S.view = "list";
  S.detail = idle(null);
  S.diff = null;
  S.diffKey = null;
  S.diffLoad = idle(null);
  S.diffFile = null;
  S.notice = null;
  S.search = { q: "", lastQ: "", ...idle([]) };
  say(`Repository ${slug(r)} selected.`);
  loadPulls();
}
/** After sign-in or at boot: open the focused workspace's repository, else the one last
 *  used on this account, and only show the repository list when neither is known. */
async function enterWorkspace() {
  const id = seq.repos;
  try {
    const r = await req("context.current", {});
    if (id !== seq.repos || S.repo) return;
    S.workspaceWhy = r.workspace;
    if (r.repository) {
      S.detected = r.repository;
      return selectRepo(r.repository);
    }
  } catch {
    /* detection is unavailable; fall through to the remembered repository */
  }
  const choice = await recallRepo();
  if (choice && S.conn && choice.origin === S.conn.origin && choice.userId === S.conn.userId)
    return selectRepo({ owner: choice.owner, repo: choice.repo });
  if (!S.repo) openRepos();
}
/** The worker pushes the focused workspace's repository as `context.changed`; follow it
 *  unless the person picked another repository by hand or something is in flight. */
function applyContext(r: { repository: RepoRef | null; workspace: WorkspaceMatch }) {
  S.workspaceWhy = r.workspace;
  const previous = S.detected;
  S.detected = r.repository;
  if (!r.repository) return;
  // Follow the focused workspace: when nothing is selected yet (even on the repository list),
  // and whenever focus moves to a different repository. A repository picked by hand stays
  // until then; a review being submitted is never interrupted.
  const submitting = [...S.submits.values()].some((x) => x.status === "submitting");
  const moved = previous === null || !sameRepo(previous, r.repository);
  if (submitting || (S.repo !== null && !moved) || sameRepo(S.repo, r.repository)) return;
  selectRepo(r.repository);
  say(`Switched to ${slug(r.repository)}, the repository of Orca’s focused workspace.`);
}
function reposScreen() {
  const d = S.repos;
  const list = h("div", { class: "scroll", "data-sk": "repos" });
  if (d.status === "loading" || d.status === "idle") add(list, skeleton());
  else if (d.status === "error") add(list, h("div", { style: "padding:10px" }, errorNote("Couldn’t load repositories.", d.error!, loadRepos)));
  else if (!d.data.items.length)
    add(
      list,
      S.repoQuery
        ? empty("search", `No repositories match “${S.repoQuery}”`, "Search matches owner and repository names.", button({ class: "btn sm", onClick: () => ((S.repoQuery = ""), (S.repoOffset = 0), focusNext("rq"), loadRepos()) }, "Clear search"))
        : empty("repo", "No repositories yet", `Hosted repositories you can access on ${host(S.conn!.origin)} appear here.`),
    );
  else
    add(
      list,
      h(
        "ul",
        { class: "ls pad", "aria-label": "Repositories", onKeydown: listKeys },
        d.data.items.map((r) => {
          const sel = S.repo && sameRepo(S.repo, r);
          return h(
            "li",
            null,
            button(
              { class: `ritem ${sel ? "sel" : ""}`, "aria-current": String(!!sel), "data-nav": "1", "data-fk": `repo:${slug(r)}`, onClick: () => selectRepo(r) },
              icon("repo", "mut"),
              h("span", { style: "min-width:0;flex:1" }, h("span", { class: "rn" }, h("span", { class: "mut" }, `${r.owner} / `), h("span", { class: "b" }, r.repo))),
              S.detected && sameRepo(S.detected, r) ? h("span", { class: "badge", title: "Detected from Orca’s focused workspace" }, "Workspace") : null,
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
    const r = await req("pulls.list", {
      owner: S.repo.owner,
      repo: S.repo.repo,
      offset: S.prOffset,
      state: S.filter === "mine" ? "open" : S.filter,
      mine: S.filter === "mine",
    });
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
    S.diff = null;
    S.diffKey = null;
    S.diffLoad = idle(null);
    S.diffFile = null;
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
    const pull = await req("pull.get", { owner: repo.owner, repo: repo.repo, number: n });
    if (id !== seq.detail) return;
    const prev = S.detail.data;
    const insp = S.inspected.get(prKey(n));
    if (prev && prev.number === n && prev.sourceSha && pull.sourceSha && prev.sourceSha !== pull.sourceSha) {
      S.notice = { kind: "warn", text: `New commits were pushed to #${n} (${short(prev.sourceSha)} → ${short(pull.sourceSha)}).` };
      // The loaded diff is the old revision: drop it so the Files tab re-fetches, and
      // let any load still in flight land dead.
      S.diff = null;
      S.diffKey = null;
      S.diffLoad = idle(null);
      seq.diff++;
      if (S.detailTab === "files") loadDiff(n);
    } else if (insp && pull.sourceSha && insp !== pull.sourceSha) S.notice = { kind: "warn", text: `#${n} has new commits since you inspected ${short(insp)}.` };
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
    const r = await req("pull.checks", { owner: S.repo!.owner, repo: S.repo!.repo, number: n });
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
    const r = await req("pull.reviews", { owner: S.repo!.owner, repo: S.repo!.repo, number: n });
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
        ? h("div", { class: "dempty" }, icon("pr"), h("div", { style: "color:var(--fg);font-weight:600" }, "Select a pull request"), h("div", { class: "sm" }, "Its description, changes, checks and reviews appear here."))
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
    add(
      body,
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
    add(
      body,
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
    h(
      "div",
      {
        class: "filters",
        role: "group",
        "aria-label": "Filter pull requests",
        "data-sk": "filters",
        // A mouse wheel scrolls vertically; turn it sideways so every filter can be reached.
        onWheel: (e: WheelEvent) => {
          const el = e.currentTarget as HTMLElement;
          if (el.scrollWidth <= el.clientWidth || Math.abs(e.deltaX) > Math.abs(e.deltaY)) return;
          e.preventDefault();
          el.scrollLeft += e.deltaY;
        },
      },
      FL.map(([f, label]) =>
        button({ class: "chip", "aria-pressed": String(S.filter === f), "data-fk": `filter:${f}`, onClick: (e: MouseEvent) => (focusNext(`filter:${f}`), (e.currentTarget as HTMLElement).scrollIntoView({ block: "nearest", inline: "nearest" }), setFilter(f)) }, label),
      ),
    ),
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

const CHECK_KIND = (c: CheckItem): "ok" | "fail" | "pend" | "skip" => {
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
  add(
    pane,
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
  add(
    pane,
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
          trigger.disabled = true;
          try {
            const result = await openExternal(webUrl);
            if (result.opened) say("Opened the pull request on CV Hub.");
            else {
              S.notice = { kind: "warn", text: "The browser didn’t open (declined, or this client can’t). Use Copy PR link to open it yourself." };
              say("The browser didn’t open. Copy the PR link.");
            }
          } finally {
            trigger.disabled = false;
          }
          render();
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
    ? h("div", { class: "insp sm", id: "insp" }, icon("circle", "s mut"), h("span", { class: "mut" }, "Not inspected yet — the Files tab shows this revision’s changes."))
    : head && insp !== head
      ? h("div", { class: "insp sm warn", id: "insp" }, icon("warn", "s"), `You inspected ${short(insp)}. The pull request has new commits.`)
      : h("div", { class: "insp sm ok", id: "insp" }, icon("check", "s"), `Inspected revision ${short(insp)} in the Files tab`);
  add(pane, inspLine);
  const filesCount = S.diff?.totalFiles;
  const TABS: Array<[DetailTab, string, string, string]> = [
    ["overview", "Overview", "", ""],
    ["files", "Files", S.diffLoad.status === "error" ? "!" : filesCount != null ? String(filesCount) : "", S.diffLoad.status === "error" ? "bad" : ""],
    ["checks", "Checks", S.checks.status === "error" ? "!" : S.checks.status === "ready" ? (nFail ? `${nFail} failing` : String(S.checks.data.total)) : "", S.checks.status === "error" || nFail ? "bad" : ""],
    ["reviews", "Reviews", S.reviews.status === "ready" ? String(S.reviews.data.total) : "", ""],
  ];
  add(
    pane,
    h(
      "div",
      {
        class: "dtabs",
        role: "tablist",
        "aria-label": "Pull request sections",
        onKeydown: (e: KeyboardEvent) => {
          const order = TABS.map((t) => t[0]);
          let i = order.indexOf(S.detailTab);
          if (e.key === "ArrowRight") i = (i + 1) % 4;
          else if (e.key === "ArrowLeft") i = (i + 3) % 4;
          else return;
          e.preventDefault();
          openDetailTab(order[i]);
        },
      },
      TABS.map(([k, label, badge, cls]) =>
        button(
          { role: "tab", class: "tab", id: `t-${k}`, "aria-selected": String(S.detailTab === k), "aria-controls": "tp", tabindex: S.detailTab === k ? "0" : "-1", "data-fk": `tab:${k}`, onClick: () => openDetailTab(k) },
          label,
          badge ? h("span", { class: `ct ${cls}` }, badge) : null,
        ),
      ),
    ),
  );
  const tp = h("div", { class: "tp", role: "tabpanel", id: "tp", "aria-labelledby": `t-${S.detailTab}` });
  if (S.detailTab === "overview") add(tp, overviewTab(pull, ckSummary, nFail, nPend));
  else if (S.detailTab === "files") add(tp, filesTab(pull, key, webUrl));
  else if (S.detailTab === "checks") add(tp, checksTab(head, ckSummary));
  else add(tp, reviewsTab(pull, key, insp, head));
  add(pane, tp);
  return pane;
}
/** Switches the detail tab; the Files tab loads its diff the first time it is needed. */
function openDetailTab(k: DetailTab) {
  S.detailTab = k;
  if (k === "files") {
    focusNext("tab:files");
    if (S.diffKey !== prKey() && S.diffLoad.status !== "loading") loadDiff();
  }
  render();
}

// ───────────────────────── overview and checks ─────────────────────────
function overviewTab(pull: PullDetail, ckSummary: string, nFail: number, nPend: number) {
  return h(
    "div",
    { class: "mgrid" },
    h("span", { class: "k" }, "Author"),
    h("span", null, pull.author),
    pull.createdAt ? [h("span", { class: "k" }, "Opened"), h("span", null, ago(pull.createdAt))] : null,
    h("span", { class: "k" }, "Changes"),
    h(
      "span",
      { style: "display:flex;gap:6px;flex-wrap:wrap;align-items:center" },
      S.diff && S.diffKey === prKey()
        ? [h("span", null, `${S.diff.totalFiles} file${S.diff.totalFiles === 1 ? "" : "s"}`), button({ class: "linkbtn", onClick: () => openDetailTab("files") }, "View")]
        : button({ class: "linkbtn", onClick: () => openDetailTab("files") }, "Open the Files tab"),
    ),
    h("span", { class: "k" }, "Checks"),
    h(
      "span",
      { style: "display:flex;gap:6px;flex-wrap:wrap;align-items:center" },
      S.checks.status === "error"
        ? [h("span", { class: "mut" }, "Unavailable"), button({ class: "linkbtn", onClick: () => loadChecks() }, "Retry")]
        : S.checks.status === "ready"
          ? [h("span", { class: nFail ? "ck-fail" : nPend ? "ck-pend" : "ck-ok" }, ckSummary), button({ class: "linkbtn", onClick: () => openDetailTab("checks") }, "View")]
          : h("span", { class: "mut" }, "Loading…"),
    ),
    h("span", { class: "k" }, "Reviews"),
    h("span", { style: "display:flex;gap:6px;flex-wrap:wrap;align-items:center" }, S.reviews.status === "ready" ? `${S.reviews.data.total} review${S.reviews.data.total === 1 ? "" : "s"}` : S.reviews.status === "error" ? "Unavailable" : "Loading…", button({ class: "linkbtn", onClick: () => (openDetailTab("reviews"), focusNext("ta")) }, "Write review")),
    h("div", { class: "ovbody" }, pull.body ? markdown(pull.body) : h("p", { class: "mut" }, "No description provided.")),
  );
}
function checksTab(head: string | null, ckSummary: string) {
  const out = h("div");
  if (S.checks.status === "error") {
    add(out, errorNote("Couldn’t load checks.", S.checks.error!, () => loadChecks(), []), h("p", { class: "mut sm", style: "margin:0" }, "The rest of this pull request is still up to date."));
    return out;
  }
  if (S.checks.status !== "ready") return skeleton(3);
  const nFail = S.checks.data.items.map(CHECK_KIND).filter((k) => k === "fail").length;
  const nPend = S.checks.data.items.map(CHECK_KIND).filter((k) => k === "pend").length;
  add(out, h("div", { class: "shd" }, h("span", { class: `${nFail ? "ck-fail" : nPend ? "ck-pend" : "ck-ok"} b` }, ckSummary), head ? h("span", { class: "mut xs mono" }, `head ${short(head)}`) : null));
  if (!S.checks.data.items.length) add(out, h("p", { class: "mut sm", style: "margin:0" }, "No checks have run for this pull request."));
  add(
    out,
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
  if (S.checks.data.total > S.checks.data.items.length) add(out, h("p", { class: "mut xs", style: "margin:0" }, `Showing ${S.checks.data.items.length} of ${S.checks.data.total}.`));
  return out;
}

// ───────────────────────── the Files tab (the in-panel diff) ─────────────────────────
/** Loads the pull request's changed files — the same `GET .../pulls/:n/diff` CV Hub's web
 *  page renders — and pins the inspected revision a review submits against. Lazy: only
 *  when the Files tab is opened, one file's patch shown at a time. */
async function loadDiff(n = S.selected!) {
  const repo = S.repo;
  if (!repo || n == null) return;
  const key = prKey(n);
  const did = ++seq.diff;
  S.diffLoad = { ...S.diffLoad, status: "loading" };
  render();
  try {
    const view = await req("pull.diff", { owner: repo.owner, repo: repo.repo, number: n }, { timeoutMs: 60000 });
    if (did !== seq.diff || S.repo !== repo || S.selected !== n) return;
    S.diff = view;
    S.diffKey = key;
    S.diffLoad = { status: "ready", data: null };
    // Inspecting the files pins the revision a review will submit against.
    S.inspected.set(key, view.headSha);
    const sub = S.submits.get(key);
    if (sub?.status === "stale") S.submits.delete(key);
    if (!view.files.some((f) => f.path === S.diffFile)) S.diffFile = view.files[0]?.path ?? null;
    say(`${view.totalFiles} file${view.totalFiles === 1 ? "" : "s"} changed. Inspecting revision ${short(view.headSha)}.`);
  } catch (error) {
    if (did !== seq.diff || S.repo !== repo || S.selected !== n) return;
    S.diff = null;
    S.diffKey = null;
    S.diffLoad = { ...S.diffLoad, status: "error", error: await guard(error) };
  }
  render();
}
function filesTab(pull: PullDetail, key: string, webUrl: string) {
  const out = h("div", { class: "sect", "aria-label": "Changed files" });
  if (S.diffLoad.status === "idle" || S.diffLoad.status === "loading") {
    add(out, skeleton(4));
    return out;
  }
  if (S.diffLoad.status === "error" || !S.diff) {
    add(out, errorNote("Couldn’t load the changes.", S.diffLoad.error!, () => loadDiff(), [button({ class: "btn sm ghost", onClick: () => openExternal(webUrl) }, icon("external", "s"), "Open in CV Hub")]));
    return out;
  }
  const view = S.diff;
  const insp = S.inspected.get(key);
  add(
    out,
    h(
      "div",
      { class: "shd" },
      h("span", { class: "b" }, `${view.totalFiles} file${view.totalFiles === 1 ? "" : "s"} changed`),
      h("span", { class: "diffstat", "aria-label": `${view.totalFiles} files, base ${short(view.baseSha)}, head ${short(view.headSha)}` }, h("span", { class: "ds add" }, `+${view.files.reduce((n, f) => n + f.additions, 0)}`), h("span", { class: "ds del" }, `−${view.files.reduce((n, f) => n + f.deletions, 0)}`)),
      view.filesTruncated ? h("span", { class: "mut xs" }, ` · showing ${view.files.length}`) : null,
      h("span", { class: "mut xs mono" }, `head ${short(view.headSha)}`),
      insp && insp === view.headSha ? h("span", { class: "ckl ck-ok" }, "inspected") : null,
    ),
  );
  if (view.filesTruncated) add(out, note("warn", "warn", [h("b", null, "More files than shown here."), ` This pull request changes ${view.totalFiles} files; the list holds the first ${view.files.length}. Open it on CV Hub to see them all.`]));
  if (!view.files.length) {
    add(out, empty("diff", "No changed files", "CV Hub reports no file changes for this pull request."));
    return out;
  }
  const current = view.files.find((f) => f.path === S.diffFile) ?? view.files[0];
  const bar = h("div", { class: "fbar" });
  // The value is set after the options exist: assigning it during construction would run
  // before the children are appended and select nothing.
  const picker = h(
    "select",
    {
      class: "in fsel mono",
      "aria-label": "Changed file",
      onChange: (e: Event) => {
        S.diffFile = (e.target as HTMLSelectElement).value;
        render();
      },
    },
    view.files.map((f) => h("option", { value: f.path }, `${f.status === "renamed" && f.oldPath ? `${f.oldPath} → ` : ""}${f.path}`)),
  );
  picker.value = current.path;
  add(bar, picker);
  add(
    bar,
    button(
      { class: "btn sm ghost", "aria-pressed": String(S.diffSplit), "aria-label": S.diffSplit ? "Show a unified diff" : "Show a split diff", title: S.diffSplit ? "Unified view" : "Split view", onClick: () => ((S.diffSplit = !S.diffSplit), render()) },
      icon("diff", "s"),
      S.diffSplit ? "Unified" : "Split",
    ),
    h("span", { style: "flex:1" }),
    button({ class: "linkbtn", onClick: () => void openExternal(webUrl) }, icon("external", "s"), "Open in CV Hub"),
  );
  add(out, bar);
  add(
    out,
    h(
      "div",
      { class: "fhrow" },
      ...fileSummary(current),
      current.binary ? null : h("span", { class: "ds add mono xs" }, `+${current.additions}`),
      current.binary ? null : h("span", { class: "ds del mono xs" }, `−${current.deletions}`),
    ),
  );
  const body = h("div", { class: "dscroll", "data-sk": "filediff" });
  if (current.binary) {
    add(body, note("warn", "file", [h("b", null, "Binary file."), " Its contents can’t be shown as text. Open it on CV Hub to see what changed."], [button({ class: "btn sm", onClick: () => void openExternal(webUrl) }, icon("external", "s"), "Open in CV Hub")]));
  } else if (current.patch === null) {
    const why = current.truncated
      ? [h("b", null, "This file’s patch is too large to show here."), " CV Hub or the panel cut it short. Open the pull request on CV Hub to read the full diff."]
      : [h("b", null, "No text patch for this file."), " CV Hub didn’t include one (a mode change, or an empty diff)."];
    add(body, note("warn", "warn", why, [button({ class: "btn sm", onClick: () => void openExternal(webUrl) }, icon("external", "s"), "Open in CV Hub")]));
  } else {
    add(body, renderPatch(current.patch, S.diffSplit));
    if (current.truncated)
      add(body, note("warn", "warn", [h("b", null, "Patch truncated."), ` Only the first part is shown here; the whole file is ${current.additions + current.deletions} changed line${current.additions + current.deletions === 1 ? "" : "s"} long. Open it on CV Hub for the full diff.`], [button({ class: "btn sm", onClick: () => void openExternal(webUrl) }, icon("external", "s"), "Open in CV Hub")]));
  }
  add(out, body);
  return out;
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
    add(
      out,
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
              h("div", { class: "rvh" }, h("span", { class: "b" }, who), h("span", { class: `rvk ${cls}` }, icon(ic, "s"), label), r.submittedAt ? h("span", { class: "mut sm" }, `· ${ago(r.submittedAt)}`) : null, r.commitSha ? [h("span", { class: "mut sm" }, "· on"), h("span", { class: "mono sm mut" }, short(r.commitSha))] : null, r.commitSha && head && r.commitSha !== head ? h("span", { class: "old" }, "older revision") : null),
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
  if (gate === "need") add(section, note("warn", "diff", [h("b", null, "Inspect the changes first."), ` A review is tied to the revision you inspect. Open the Files tab (${head ? short(head) : "this pull request"}) before submitting — you can write your draft now.`], [button({ class: "btn sm", onClick: () => openDetailTab("files") }, "Open the Files tab")]));
  else if (gate === "stale") add(section, note("warn", "warn", [h("b", null, "New commits since you inspected."), ` You inspected ${short(insp)}; the pull request is now at ${short(head)}. Review the new revision before submitting. Your draft is kept.`], [button({ class: "btn sm", onClick: () => ((S.diff = null), (S.diffKey = null), openDetailTab("files")) }, "Review new revision")]));
  else add(section, h("div", { class: "gate sm" }, icon("check", "s"), h("span", null, `Reviewing revision ${short(insp)} · inspected in the Files tab`)));
  add(
    section,
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
    return gate === "need" ? "Inspect the changes in the Files tab to enable submitting." : gate === "stale" ? "Review the new revision to enable submitting." : sub.status === "stale" ? "Inspect the latest revision to enable submitting." : blocked ? "Reload the review history before retrying." : nb ? (d.kind === "changes_requested" ? "Explain what needs to change." : "Write a comment to submit.") : sub.status === "submitting" ? "Submitting…" : `Submits to revision ${short(insp)}.`;
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
  add(
    section,
    h("div", { style: "display:flex;flex-direction:column;gap:4px" }, h("label", { class: "lbl", for: "ta" }, draft.kind === "approved" ? "Summary (optional)" : "Summary"), ta, h("span", { class: "mut xs" }, "Markdown supported. Drafts stay in this panel for this account until you submit or sign out; they aren’t saved to disk.")),
  );
  if (sub.status === "ok") add(section, note("ok", "check", [h("b", null, "Review submitted."), ` ${sub.text ?? ""}`]));
  if (sub.status === "error") add(section, note("err", "warn", [h("b", null, "Couldn’t submit your review."), ` ${sub.text ?? ""} Nothing was recorded and your draft is kept.`], [button({ class: "btn sm", onClick: () => submit(key) }, "Retry")]));
  if (sub.status === "stale") add(section, note("warn", "warn", [h("b", null, "The pull request moved on."), " CV Hub rejected the review because the revision you inspected is no longer the head. Inspect the new revision, then submit. Your draft is kept."], [button({ class: "btn sm", onClick: () => ((S.diff = null), (S.diffKey = null), openDetailTab("files")) }, "Review new revision")]));
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
  S.submits.set(key, { status: "submitting" });
  say("Submitting review…");
  render();
  const reviewsBefore = S.reviews.data.items.map((r) => r.id);
  try {
    await req("review.submit", { owner: S.repo.owner, repo: S.repo.repo, number: pull.number, expectedHeadSha: insp, state: draft.kind, body: draft.body });
    const verb = { commented: "Commented on", approved: "Approved", changes_requested: "Requested changes on" }[draft.kind];
    S.drafts.delete(key);
    S.submits.set(key, { status: "ok", text: `${verb} revision ${short(insp)}. It’s now in the history above.` });
    say("Review submitted.");
    void loadReviews();
  } catch (error) {
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
    const { results } = await req("code.search", { owner: S.repo.owner, repo: S.repo.repo, query: q }, { timeoutMs: 60000 });
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
    add(
      body,
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
// The worker pushes sign-in progress and the focused workspace's repository; nothing polls.
onPush("auth.changed", ({ status }) => {
  applyStatus(status);
  render();
});
onPush("context.changed", (payload) => {
  applyContext(payload);
  render();
});
(async () => {
  try {
    const status = await req("auth.status", {});
    S.conn = status.connection;
    S.legacy = status.legacy;
    // A panel reload during sign-in resumes the worker-owned attempt; pushes keep it current.
    S.attempt = status.attempt?.phase === "connected" ? null : status.attempt;
    S.apiOrigin = status.apiOrigin;
    if (S.conn && !S.conn.expired) await enterWorkspace();
    else S.screen = "auth";
  } catch (error) {
    // No worker answer usually means the worker could not start.
    S.auth.error = failure(error);
    S.screen = "auth";
  }
  S.booted = true;
  render();
})();
