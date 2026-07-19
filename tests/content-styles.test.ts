// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest";
import { injectContentStyles } from "../src/content/styles";

describe("content translation styles", () => {
  afterEach(() => {
    document.querySelector("#wupage-translation-style")?.remove();
  });

  it("inherits source colors in every translation text mode", () => {
    injectContentStyles();
    const css = document.querySelector("#wupage-translation-style")?.textContent ?? "";

    expect(css).toMatch(/data-wupage-mode="block"[^}]*color:\s*inherit/s);
    expect(css).toMatch(/data-wupage-container="heading"[^}]*color:\s*inherit/s);
    expect(css).toMatch(/data-wupage-mode="inline"[^}]*color:\s*inherit/s);
    expect(css).toMatch(/data-wupage-mode="code-comment"[^}]*color:\s*inherit/s);
  });
});
