import { z } from "zod";
import { isLoopback } from "./rest-client";

export type RepoRef = { owner: string; repo: string };

/** Orca's `workspace.readContext`. `remotes` exists only on hosts that report them. */
export const workspaceContextSchema = z
  .object({
    branch: z.string(),
    displayName: z.string(),
    remotes: z.array(z.object({ name: z.string(), url: z.string() })).optional(),
  })
  .passthrough()
  .nullable();

/** Host and path of a git remote, in URL (`https://host/o/r.git`, `ssh://git@host/o/r`) or
 *  scp-like (`git@host:o/r.git`) form. */
function splitRemote(url: string): { host: string; path: string } | null {
  const scp = /^[^@/\s]+@([^:/\s]+):(?!\/\/)(.+)$/.exec(url);
  if (scp) return { host: scp[1].toLowerCase(), path: scp[2] };
  try {
    const parsed = new URL(url);
    if (!["https:", "http:", "ssh:", "git:"].includes(parsed.protocol)) return null;
    return { host: parsed.hostname.toLowerCase(), path: decodeURIComponent(parsed.pathname) };
  } catch {
    return null;
  }
}

/** Hosts that serve git for a CV Hub API origin. CV Hub runs its API on `api.<base>`, the web
 *  app on `<base>` and git on `git.<base>`; a loopback API serves git on loopback too. */
function servesGit(apiOrigin: string, host: string): boolean {
  const api = new URL(apiOrigin).hostname.toLowerCase();
  if (isLoopback(api)) return isLoopback(host);
  const base = api.replace(/^api\./, "");
  return host === api || host === base || host === `git.${base}`;
}

/** The owner/repo a remote points at on this CV Hub server, or null. */
export function repoFromRemote(apiOrigin: string, url: string): RepoRef | null {
  const remote = splitRemote(url.trim());
  if (!remote || !servesGit(apiOrigin, remote.host)) return null;
  const parts = remote.path.replace(/\/+$/, "").replace(/\.git$/, "").split("/").filter(Boolean);
  if (parts.length < 2) return null;
  const [owner, repo] = parts.slice(-2);
  const ok = (s: string) => s.length <= 255 && /^[A-Za-z0-9._-]+$/.test(s) && s !== "." && s !== "..";
  return ok(owner) && ok(repo) ? { owner, repo } : null;
}

/** Candidates in the order to try: `origin` first, then the other remotes, without duplicates. */
export function candidateRepos(apiOrigin: string, remotes: Array<{ name: string; url: string }>): RepoRef[] {
  const ordered = [...remotes].sort((a, b) => Number(b.name === "origin") - Number(a.name === "origin"));
  const seen = new Set<string>();
  const out: RepoRef[] = [];
  for (const r of ordered) {
    const ref = repoFromRemote(apiOrigin, r.url);
    const key = ref && `${ref.owner}/${ref.repo}`.toLowerCase();
    if (ref && !seen.has(key!)) {
      seen.add(key!);
      out.push(ref);
    }
  }
  return out;
}
