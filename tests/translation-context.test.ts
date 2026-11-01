// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest";
import { buildTranslationContext } from "../src/content/translation-context";

afterEach(() => {
  document.body.innerHTML = "";
  document.title = "";
});

describe("translation context", () => {
  it("does not send opted-out text, SVG labels or editor comments as context", () => {
    document.body.innerHTML = `<main><p>Visible article.</p><p translate="no">Private account name.</p>
      <p class="notranslate">Private product name.</p><svg><text>Diagram label</text></svg>
      <div contenteditable="plaintext-only"><code>// Private draft</code></div></main>`;
    const context = buildTranslationContext();
    expect(context).toContain("Visible article.");
    for (const text of ["Private account", "Private product", "Diagram label", "Private draft"]) expect(context).not.toContain(text);
  });
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

  it.each(["main", "article", "div role='main'"])("reads local div-based context inside %s", (rootTag) => {
    const closingTag = rootTag.split(" ")[0];
    document.body.innerHTML = `<${rootTag}><div>Variance means type substitution here.</div><div id="focus">Read <b>this</b> definition.</div></${closingTag}>`;
    const context = buildTranslationContext([document.querySelector("#focus")!]);
    expect(context).toContain("type substitution");
    expect(context).toContain("Read this definition.");
  });

  it("excludes hidden descendants, executable text and editable drafts inside otherwise readable blocks", () => {
    document.body.innerHTML = `<main><p id="focus">Visible message.
      <span hidden>Hidden account details</span><span style="display:none">Collapsed reply</span>
      <span aria-hidden="true">Accessibility duplicate</span>
      <span contenteditable="">Unsent draft</span><script>Private executable content</script>
      <span class="wupage-translation">Previous translation</span></p></main>`;
    const context = buildTranslationContext([document.querySelector("#focus")!]);
    expect(context).toContain("Visible message.");
    for (const excluded of ["Hidden account", "Collapsed reply", "Accessibility duplicate", "Unsent draft", "executable", "Previous translation"])
      expect(context).not.toContain(excluded);
  });

  it("does not use a focused draft or a hidden panel as context", () => {
    document.body.innerHTML = `<main><div contenteditable="plaintext-only"><p id="draft">Do not send this draft.</p></div>
      <section style="visibility:hidden"><p>Hidden panel content.</p></section></main>`;
    expect(buildTranslationContext([document.querySelector("#draft")!])).toBeUndefined();
  });
});
