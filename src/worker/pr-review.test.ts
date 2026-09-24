import { describe, expect, it } from "vitest";
import { readReviewFile } from "./pr-review";
const context = {
  connectionId: "session-1",
  owner: "acme",
  repo: "demo",
  number: 7,
  repositoryId: "repo",
  baseSha: "b".repeat(40),
  mergeBaseSha: "a".repeat(40),
  headSha: "c".repeat(40),
};
const file = {
  path: "new #%.ts",
  oldPath: "old.ts",
  status: "renamed" as const,
  additions: 1,
  deletions: 1,
};
describe("native diff mapping", () => {
  it("loads original rename contents at the merge base and new contents at head", async () => {
    const requests: string[] = [];
    const result = await readReviewFile(
      { context, file },
      {
        connectionId: "session-1",
        json: async (url) => {
          requests.push(url);
          return { kind: "text", content: requests.length === 1 ? "before" : "after" };
        },
      },
    );
    expect(
      requests.map((url) => new URL(url, "https://hub.example").searchParams.get("sha")),
    ).toEqual(["a".repeat(40), "c".repeat(40)]);
    expect(
      requests.map((url) => new URL(url, "https://hub.example").searchParams.get("path")),
    ).toEqual(["old.ts", "new #%.ts"]);
    expect(result).toEqual({
      original: { kind: "text", content: "before" },
      modified: { kind: "text", content: "after" },
    });
  });
  it("represents absent sides without conflating empty files or failed fetches", async () => {
    const client = { connectionId: "session-1", json: async () => ({ kind: "text", content: "" }) };
    expect(await readReviewFile({ context, file: { ...file, status: "added" } }, client)).toEqual({
      original: { kind: "absent" },
      modified: { kind: "text", content: "" },
    });
    expect(await readReviewFile({ context, file: { ...file, status: "deleted" } }, client)).toEqual(
      { original: { kind: "text", content: "" }, modified: { kind: "absent" } },
    );
    // A failed read becomes an error side for that file, never an empty text side or a leak.
    const failing = await readReviewFile(
      { context, file },
      {
        ...client,
        json: async () => {
          throw new Error("[not_found] Not found on CV Hub");
        },
      },
    );
    expect(failing.original).toEqual({ kind: "error", code: "not_found", message: "This file is unavailable at the reviewed revision." });
    const leaky = await readReviewFile(
      { context, file },
      {
        ...client,
        json: async () => {
          throw new Error("socket hang up Authorization: Bearer secret-token");
        },
      },
    );
    expect(JSON.stringify(leaky)).not.toContain("secret-token");
    expect(leaky.modified).toMatchObject({ kind: "error", code: "unavailable" });
  });
  it("refuses snapshots from a replaced account without fetching", async () => {
    const result = await readReviewFile(
      { context, file },
      {
        connectionId: "session-2",
        json: async () => {
          throw new Error("must not fetch");
        },
      },
    );
    expect(result.original).toMatchObject({ kind: "error", code: "connection_changed" });
    expect(result.modified).toMatchObject({ kind: "error", code: "connection_changed" });
  });
});
