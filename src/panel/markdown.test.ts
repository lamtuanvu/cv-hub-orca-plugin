// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";

const openExternal = vi.fn(async () => ({ opened: true }));
vi.mock("./bridge", () => ({ openExternal }));
const { markdown } = await import("./markdown");

describe("markdown", () => {
  it("renders GitHub-flavored Markdown", () => {
    const root = markdown(
      [
        "## What",
        "",
        "Some *emphasis*, **bold**, ~~gone~~ and `code`.",
        "",
        "- [x] done",
        "- [ ] todo",
        "  1. nested",
        "",
        "> quoted",
        "",
        "| a | b |",
        "| - | - |",
        "| 1 | 2 |",
        "",
        "```ts",
        "const x = 1;",
        "```",
        "",
        "---",
      ].join("\n"),
    );
    expect(root.querySelector("h2")?.textContent).toBe("What");
    expect(root.querySelector("em")?.textContent).toBe("emphasis");
    expect(root.querySelector("strong")?.textContent).toBe("bold");
    expect(root.querySelector("del")?.textContent).toBe("gone");
    expect(root.querySelectorAll("input[type=checkbox]")).toHaveLength(2);
    expect(root.querySelector("li ol li")?.textContent).toBe("nested");
    expect(root.querySelector("blockquote")?.textContent?.trim()).toBe("quoted");
    expect(root.querySelectorAll("td")).toHaveLength(2);
    expect(root.querySelector("pre code")?.textContent).toBe("const x = 1;\n");
    expect(root.querySelector("hr")).not.toBeNull();
  });

  it("shows raw HTML as text and strips anything active", () => {
    const root = markdown('<img src=x onerror="alert(1)"><script>alert(1)</script>\n\n[x](javascript:alert(1))');
    expect(root.querySelector("img, script, [onerror]")).toBeNull();
    expect(root.textContent).toContain("<img");
    const link = root.querySelector("a");
    expect(link).toBeNull();
  });

  it("opens web links through Orca, never by navigating", () => {
    const root = markdown("See [the docs](https://hub.example.com/docs).");
    const link = root.querySelector("a")!;
    expect(link.getAttribute("href")).toBeNull();
    expect(link.title).toBe("https://hub.example.com/docs");
    link.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    expect(openExternal).toHaveBeenCalledWith("https://hub.example.com/docs");
  });
});
