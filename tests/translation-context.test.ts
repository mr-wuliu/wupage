// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest";
import { buildTranslationContext } from "../src/content/translation-context";

afterEach(() => {
  document.body.innerHTML = "";
  document.title = "";
});

describe("translation context", () => {
  it("retains local context near the end of a long document", () => {
    document.body.innerHTML = `<main><p>${"Unrelated introduction. ".repeat(200)}</p>
      <h2>Statistics</h2><p>Variance measures the spread of a probability distribution.</p>
      <p id="focus">A high variance indicates more spread.</p></main>`;
    const context = buildTranslationContext([document.querySelector("#focus")!]);
    expect(context).toContain("probability distribution");
    expect(context).toContain("A high variance");
    expect(context!.length).toBeLessThanOrEqual(2400);
  });

  it("includes div-based email prose but excludes drafts and translation output", () => {
    document.body.innerHTML = `<div role="main"><div id="body">Please review the attached contract.
      <span class="wupage-translation">Existing translation</span></div>
      <div contenteditable="true"><p>Unsent reply draft</p></div>
      <div hidden><p>Hidden message</p></div></div>`;
    const context = buildTranslationContext([document.querySelector("#body")!]);
    expect(context).toContain("attached contract");
    expect(context).not.toContain("Existing translation");
    expect(context).not.toContain("Unsent reply draft");
    expect(context).not.toContain("Hidden message");
  });
});
