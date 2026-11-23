import { describe, expect, it } from "vitest";
import { diffForPanel, fetchPullDiff, panelFile, type PullDiff } from "./pull-diff";

const base = "a".repeat(40);
const head = "c".repeat(40);
const pull = { owner: "acme", repo: "demo", number: 7 };

/** A fake CV Hub serving one PR diff, exactly as its web page receives it. */
function hub(files: PullDiff["files"], shas = { baseSha: base, headSha: head }) {
  const requests: string[] = [];
  const client = {
    json: async (path: string) => {
      requests.push(path);
      if (path === "/api/v1/repos/acme/demo/pulls/7/diff") return { diff: { ...shas, files } };
      throw new Error("must not fetch anything else");
    },
  };
  return { client, requests };
}

describe("the diff behind the panel's Files tab", () => {
  it("fetches the same endpoint CV Hub's web page renders", async () => {
    const files = [{ path: "a.ts", status: "modified" as const, additions: 1, deletions: 1, patch: "@@ -1 +1 @@\n-1\n+2\n" }];
    const { client, requests } = hub(files);
    const diff = await fetchPullDiff(client, pull);
    expect(requests).toEqual(["/api/v1/repos/acme/demo/pulls/7/diff"]);
    expect(diff).toEqual({ baseSha: base, headSha: head, files });
  });

  it("carries each file's patch, status and counts to the panel", () => {
    const files: PullDiff["files"] = [
      { path: "added.ts", status: "added", additions: 1, deletions: 0, patch: "@@ -0,0 +1 @@\n+x\n" },
      { path: "gone.ts", status: "deleted", additions: 0, deletions: 2, patch: "@@ -1,2 +0,0 @@\n-a\n-b\n" },
      { path: "moved.ts", oldPath: "old.ts", status: "renamed", additions: 1, deletions: 1, patch: "@@ -1 +1 @@\n-a\n+b\n" },
      { path: "logo.png", status: "modified", additions: 0, deletions: 0, binary: true },
      { path: "cut.ts", status: "modified", additions: 3, deletions: 3, truncated: true },
    ];
    const view = diffForPanel({ baseSha: base, headSha: head, files });
    expect(view).toEqual({
      headSha: head,
      baseSha: base,
      totalFiles: 5,
      filesTruncated: false,
      files: [
        { path: "added.ts", oldPath: null, status: "added", additions: 1, deletions: 0, binary: false, truncated: false, patch: "@@ -0,0 +1 @@\n+x\n" },
        { path: "gone.ts", oldPath: null, status: "deleted", additions: 0, deletions: 2, binary: false, truncated: false, patch: "@@ -1,2 +0,0 @@\n-a\n-b\n" },
        { path: "moved.ts", oldPath: "old.ts", status: "renamed", additions: 1, deletions: 1, binary: false, truncated: false, patch: "@@ -1 +1 @@\n-a\n+b\n" },
        { path: "logo.png", oldPath: null, status: "modified", additions: 0, deletions: 0, binary: true, truncated: false, patch: null },
        { path: "cut.ts", oldPath: null, status: "modified", additions: 3, deletions: 3, binary: false, truncated: true, patch: null },
      ],
    });
  });

  it("cuts an oversized patch on a line boundary and flags it truncated", () => {
    const line = "+a line of changes that is long enough to matter for the total\n";
    const huge = `@@ -1 +1,${1 << 20} @@\n${line.repeat(2400)}`;
    const view = panelFile({ path: "huge.ts", status: "modified", additions: 1, deletions: 1, patch: huge }, { total: 0 });
    expect(view.truncated).toBe(true);
    expect(new TextEncoder().encode(view.patch!).length).toBeLessThanOrEqual(60 * 1024);
    expect(view.patch!.endsWith("\n")).toBe(true);
    expect(view.patch!.startsWith("@@ -1 +1")).toBe(true);
  });

  it("drops the patch once the payload budget is spent, keeping the file listed", () => {
    const budget = { total: 0 };
    const patch = `${"+x\n".repeat(1000)}`;
    const first = panelFile({ path: "one.ts", status: "modified", additions: 1, deletions: 0, patch }, budget);
    expect(first.patch).toBe(patch);
    budget.total = 320 * 1024; // spent
    const second = panelFile({ path: "two.ts", status: "modified", additions: 1, deletions: 0, patch }, budget);
    expect(second).toMatchObject({ path: "two.ts", truncated: true, patch: null });
  });

  it("lists at most 400 files and says when there are more", () => {
    const files = Array.from({ length: 401 }, (_, i) => ({
      path: `f${i}.ts`,
      status: "modified" as const,
      additions: 1,
      deletions: 1,
      patch: "@@ -1 +1 @@\n-a\n+b\n",
    }));
    const view = diffForPanel({ baseSha: base, headSha: head, files });
    expect(view.files).toHaveLength(400);
    expect(view.totalFiles).toBe(401);
    expect(view.filesTruncated).toBe(true);
  });
});
