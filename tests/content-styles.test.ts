// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { injectContentStyles } from "../src/content/styles";
import { discoverShadowRoots } from "../src/content/dom-roots";

describe("content translation styles", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    document.body.replaceChildren();
    document.querySelector("#wupage-translation-style")?.remove();
  });

  it("repairs removed or overwritten styles after a host refresh", async () => {
    injectContentStyles();
    const original = document.querySelector("#wupage-translation-style")!.textContent;
    document.querySelector("#wupage-translation-style")!.remove();
    await vi.waitFor(() => expect(document.querySelector("#wupage-translation-style")?.textContent).toBe(original));
    document.querySelector("#wupage-translation-style")!.textContent = "";
    await vi.waitFor(() => expect(document.querySelector("#wupage-translation-style")?.textContent).toBe(original));
  });

  it("repairs pending styles after ambient DOM constructors disappear", async () => {
    vi.useFakeTimers();
    injectContentStyles();
    const host = document.createElement("div");
    document.body.append(host);
    const root = host.attachShadow({ mode: "open" });
    discoverShadowRoots(host);
    const style = root.querySelector("#wupage-translation-style")!;
    const original = style.textContent;
    style.remove();
    await Promise.resolve(); // Deliver the mutation and schedule its repair.
    vi.stubGlobal("Document", undefined);
    vi.stubGlobal("ShadowRoot", undefined);
    vi.stubGlobal("MutationObserver", undefined);

    expect(() => vi.advanceTimersByTime(100)).not.toThrow();
    expect(root.querySelector("#wupage-translation-style")).toBe(style);
    expect(style.textContent).toBe(original);
  });

  it("inherits source colors in every translation text mode", () => {
    injectContentStyles();
    const css = document.querySelector("#wupage-translation-style")?.textContent ?? "";

    expect(css).toMatch(/data-wupage-mode="block"[^}]*color:\s*inherit/s);
    expect(css).toMatch(/data-wupage-container="heading"[^}]*color:\s*inherit/s);
    expect(css).toMatch(/data-wupage-mode="inline"[^}]*color:\s*inherit/s);
    expect(css).toMatch(/data-wupage-mode="code-comment"[^}]*color:\s*inherit/s);
    expect(css).toMatch(/data-wupage-preserve-whitespace="true"[^}]*white-space:\s*pre-wrap/s);
    expect(css).toMatch(/data-wupage-container="youtube-description"[^}]*display:\s*inline/s);
    expect(css).toMatch(/youtube-description[^}]*:not\(\[data-wupage-display-mode="replace"\]\)::before[^}]*content:\s*"\\A"/s);
    expect(css).toMatch(/data-wupage-display-mode="replace"[^}]*font:\s*inherit/s);
    expect(css).toMatch(/\.wupage-replaced-source[^}]*display:\s*none\s*!important/s);
    expect(css).toMatch(/data-wupage-container="image-text"[^}]*display:\s*block/s);
    expect(css).toMatch(/data-wupage-container="image-text"[^}]*font-size:\s*0\.95em/s);
    expect(css).toMatch(/data-wupage-container="image-text"[^}]*white-space:\s*pre-wrap/s);
    expect(css).toMatch(/data-wupage-container="image-text"[^}]*color:\s*inherit/s);
    expect(css).toMatch(/data-wupage-container="image-text"[^}]*background:\s*transparent/s);
    expect(css).toMatch(/data-wupage-image-layout="interleaved"[^}]*background:\s*transparent/s);
    expect(css).toMatch(/data-wupage-image-layout="interleaved"[^}]*text-align:\s*center/s);
    expect(css).toMatch(/wupage-image-text-row[^}]*font-size:\s*var\(--wupage-image-font-size\)/s);
  });
});
