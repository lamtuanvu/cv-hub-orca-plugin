import { describe, expect, it } from "vitest";
import { pullWebUrl } from "./pull-url";

describe("pullWebUrl", () => {
  it("uses the verified web origin when the API and frontend use different ports", () => {
    expect(pullWebUrl("http://localhost:3000", { owner: "acme", repo: "demo", number: 7 }, "http://localhost:5173"))
      .toBe("http://localhost:5173/dashboard/repositories/acme/demo/pulls/7");
  });
  it("links to the web PR page instead of the API", () => {
    expect(pullWebUrl("https://api.hub.controlvector.io", { owner: "controlvector", repo: "cv-hub", number: 7 }))
      .toBe("https://hub.controlvector.io/dashboard/repositories/controlvector/cv-hub/pulls/7");
  });

  it("preserves custom origins and encodes repository names", () => {
    expect(pullWebUrl("https://hub.example:8443", { owner: "my team", repo: "a/b", number: 12 }))
      .toBe("https://hub.example:8443/dashboard/repositories/my%20team/a%2Fb/pulls/12");
  });
});
