import { describe, expect, it } from "vitest";
import { candidateRepos, repoFromRemote } from "./workspace-repo";

const API = "https://api.hub.controlvector.io";
describe("mapping a git remote to a CV Hub repository", () => {
  it.each([
    ["https://git.hub.controlvector.io/acme/widgets.git", { owner: "acme", repo: "widgets" }],
    ["https://hub.controlvector.io/acme/widgets", { owner: "acme", repo: "widgets" }],
    ["ssh://git@git.hub.controlvector.io:2222/acme/widgets.git", { owner: "acme", repo: "widgets" }],
    ["git@git.hub.controlvector.io:acme/widgets.git", { owner: "acme", repo: "widgets" }],
    ["https://GIT.hub.controlvector.io/acme/widgets.git/", { owner: "acme", repo: "widgets" }],
  ])("%s", (url, expected) => expect(repoFromRemote(API, url)).toEqual(expected));

  it.each([
    "https://github.com/acme/widgets.git",
    "https://evilhub.controlvector.io/a/b.git",
    "https://git.hub.controlvector.io.evil.example/a/b.git",
    "https://git.hub.controlvector.io/onlyone",
    "https://git.hub.controlvector.io/a/%2E%2E",
    "file:///srv/a/b.git",
  ])("ignores %s", (url) => expect(repoFromRemote(API, url)).toBeNull());

  it("accepts loopback remotes for a loopback API", () => {
    expect(repoFromRemote("http://localhost:3001", "http://127.0.0.1:3000/acme/demo.git")).toEqual({ owner: "acme", repo: "demo" });
    expect(repoFromRemote("http://localhost:3001", "https://git.hub.controlvector.io/acme/demo.git")).toBeNull();
  });

  it("tries origin first and drops duplicates", () => {
    expect(
      candidateRepos(API, [
        { name: "upstream", url: "https://git.hub.controlvector.io/acme/up.git" },
        { name: "origin", url: "https://git.hub.controlvector.io/me/demo.git" },
        { name: "mirror", url: "git@git.hub.controlvector.io:me/demo.git" },
      ]),
    ).toEqual([{ owner: "me", repo: "demo" }, { owner: "acme", repo: "up" }]);
  });
});
