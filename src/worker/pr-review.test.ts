import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DiffCache, readReviewFile, reversePatch, type PullDiff } from "./pr-review";

const base = "a".repeat(40);
const head = "c".repeat(40);
const context = { connectionId: "session-1", owner: "acme", repo: "demo", number: 7, baseSha: base, headSha: head };
const rename = { path: "new #%.ts", oldPath: "old.ts", status: "renamed" as const, additions: 1, deletions: 1 };
const diff = (files: PullDiff["files"], shas = { baseSha: base, headSha: head }) => ({ diff: { ...shas, files } });

/** A fake CV Hub serving one PR diff and blobs at the head revision. */
function hub(files: PullDiff["files"], blobs: Record<string, unknown>, shas?: { baseSha: string; headSha: string }) {
  const requests: string[] = [];
  const client = {
    connectionId: "session-1",
    json: async (path: string) => {
      requests.push(path);
      if (path === "/api/v1/repos/acme/demo/pulls/7/diff") return diff(files, shas);
      const blob = blobs[path];
      if (blob instanceof Error) throw blob;
      if (!blob) throw new Error("[not_found] Not found on CV Hub");
      return blob;
    },
  };
  return { client, requests };
}
const text = (content: string) => ({ size: content.length, isBinary: false, content });
const blobPath = (path: string) => `/api/v1/repos/acme/demo/blob/${head}/${path.split("/").map(encodeURIComponent).join("/")}`;

describe("native diff from CV Hub's web endpoints", () => {
  it("serves the head blob as modified and undoes the patch for the original, at the old path", async () => {
    const files = [{ ...rename, patch: "@@ -1,2 +1,2 @@\n keep\n-before\n+after\n" }];
    const { client, requests } = hub(files, { [blobPath("new #%.ts")]: text("keep\nafter\n") });
    const result = await readReviewFile({ context, file: rename }, client, new DiffCache());
    expect(result).toEqual({
      original: { kind: "text", content: "keep\nbefore\n" },
      modified: { kind: "text", content: "keep\nafter\n" },
    });
    // Blobs are pinned to the head SHA and the path is encoded per segment.
    expect(requests).toContain(`/api/v1/repos/acme/demo/blob/${head}/new%20%23%25.ts`);
  });
  it("represents added, deleted, binary and oversized files without conflating them", async () => {
    const files = [
      { path: "added.ts", status: "added" as const, additions: 1, deletions: 0, patch: "@@ -0,0 +1 @@\n+x\n" },
      { path: "gone.ts", status: "deleted" as const, additions: 0, deletions: 2, patch: "@@ -1,2 +0,0 @@\n-a\n-b\n" },
      { path: "logo.png", status: "modified" as const, additions: 0, deletions: 0, binary: true },
      { path: "huge.ts", status: "modified" as const, additions: 1, deletions: 1, truncated: true },
    ];
    const { client } = hub(files, { [blobPath("added.ts")]: text("x\n"), [blobPath("huge.ts")]: text("y\n") });
    const cache = new DiffCache();
    const load = (file: (typeof files)[number]) => readReviewFile({ context, file }, client, cache);
    expect(await load(files[0])).toEqual({ original: { kind: "absent" }, modified: { kind: "text", content: "x\n" } });
    expect(await load(files[1])).toEqual({ original: { kind: "text", content: "a\nb\n" }, modified: { kind: "absent" } });
    expect(await load(files[2])).toEqual({ original: { kind: "binary" }, modified: { kind: "binary" } });
    const huge = await load(files[3]);
    expect(huge.original).toMatchObject({ kind: "limited" });
    expect(huge.modified).toEqual({ kind: "text", content: "y\n" });
  });
  it("fetches the diff once per review revision", async () => {
    const files = [{ path: "a.ts", status: "modified" as const, additions: 1, deletions: 1, patch: "@@ -1 +1 @@\n-1\n+2\n" }];
    const { client, requests } = hub(files, { [blobPath("a.ts")]: text("2\n") });
    const cache = new DiffCache();
    await readReviewFile({ context, file: files[0] }, client, cache);
    await readReviewFile({ context, file: files[0] }, client, cache);
    expect(requests.filter((r) => r.endsWith("/diff"))).toHaveLength(1);
  });
  it("refuses to serve a review whose PR moved on since it opened", async () => {
    const files = [{ path: "a.ts", status: "modified" as const, additions: 1, deletions: 1, patch: "@@ -1 +1 @@\n-1\n+2\n" }];
    const { client } = hub(files, {}, { baseSha: base, headSha: "d".repeat(40) });
    const result = await readReviewFile({ context, file: files[0] }, client, new DiffCache());
    expect(result.original).toMatchObject({ kind: "error", code: "revision_changed" });
    expect(result.modified).toMatchObject({ kind: "error", code: "revision_changed" });
  });
  it("turns failed reads into error sides without leaking details", async () => {
    const files = [{ path: "a.ts", status: "modified" as const, additions: 1, deletions: 1, patch: "@@ -1 +1 @@\n-1\n+2\n" }];
    const leaky = hub(files, { [blobPath("a.ts")]: new Error("socket hang up Authorization: Bearer secret-token") });
    const result = await readReviewFile({ context, file: files[0] }, leaky.client, new DiffCache());
    expect(JSON.stringify(result)).not.toContain("secret-token");
    expect(result.modified).toMatchObject({ kind: "error", code: "unavailable" });
    const mismatch = hub(files, { [blobPath("a.ts")]: text("something else\n") });
    expect((await readReviewFile({ context, file: files[0] }, mismatch.client, new DiffCache())).original).toMatchObject({
      kind: "error",
      code: "patch_mismatch",
    });
  });
  it("refuses snapshots from a replaced account without fetching", async () => {
    const client = {
      connectionId: "session-2",
      json: async () => {
        throw new Error("must not fetch");
      },
    };
    const result = await readReviewFile({ context, file: rename }, client, new DiffCache());
    expect(result.original).toMatchObject({ kind: "error", code: "connection_changed" });
    expect(result.modified).toMatchObject({ kind: "error", code: "connection_changed" });
  });
});

describe("reversePatch", () => {
  it("handles missing final newlines on either side", () => {
    expect(reversePatch("a\n", "@@ -1 +1 @@\n-a\n\\ No newline at end of file\n+a\n")).toBe("a");
    expect(reversePatch("a", "@@ -1 +1 @@\n-a\n+a\n\\ No newline at end of file\n")).toBe("a\n");
    expect(reversePatch("same\n", "")).toBe("same\n");
  });
  it("reproduces the original for git's own diffs", () => {
    // Deterministic pseudo-random edits, including CRLF lines, blank lines and missing newlines.
    let seed = 42;
    const rnd = (n: number) => ((seed = (seed * 1103515245 + 12345) % 2 ** 31), seed % n);
    const words = ["a", "b", "", "  x", "d\r", "e"];
    const dir = mkdtempSync(join(tmpdir(), "cvhub-reverse-"));
    for (let i = 0; i < 150; i++) {
      const lines = Array.from({ length: rnd(12) }, () => words[rnd(words.length)] + rnd(3));
      const before = lines.join("\n") + (lines.length && rnd(10) < 7 ? "\n" : "");
      const edited = before.split("\n");
      for (let k = 0; k <= rnd(4); k++) {
        const at = rnd(edited.length + 1);
        const op = rnd(3);
        if (op === 0) edited.splice(at, 0, `n${rnd(9)}`);
        else if (op === 1) edited.splice(at, 1);
        else edited[at] = `m${rnd(9)}`;
      }
      const after = rnd(10) === 0 ? "" : edited.join("\n");
      writeFileSync(join(dir, "a"), before);
      writeFileSync(join(dir, "b"), after);
      let out: string;
      try {
        out = execFileSync("git", ["diff", "--no-index", "--patch", "a", "b"], { cwd: dir, encoding: "utf8" });
      } catch (error) {
        out = (error as { stdout: string }).stdout; // exit status 1 means "files differ"
      }
      const at = out.indexOf("\n@@");
      expect(reversePatch(after, at === -1 ? "" : out.slice(at + 1))).toBe(before);
    }
  }, 60_000);
});
