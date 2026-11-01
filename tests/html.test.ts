// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { htmlFragment, setHtmlContent, supportsHtmlContent } from "../src/shared/html";

function xhtml(): Document {
  return new DOMParser().parseFromString('<html xmlns="http://www.w3.org/1999/xhtml"><head/><body/></html>', "application/xhtml+xml");
}

describe("HTML content in host documents", () => {
  it("accepts HTML, XHTML and browser-generated HTML viewers, and rejects SVG/XML", () => {
    expect(supportsHtmlContent(document)).toBe(true);
    expect(supportsHtmlContent(xhtml())).toBe(true);
    const viewer = document.implementation.createHTMLDocument("");
    Object.defineProperty(viewer, "contentType", { value: "image/png" });
    expect(supportsHtmlContent(viewer)).toBe(true);
    expect(supportsHtmlContent(new DOMParser().parseFromString('<svg xmlns="http://www.w3.org/2000/svg"/>', "image/svg+xml"))).toBe(false);
    expect(supportsHtmlContent(new DOMParser().parseFromString('<document/>', "application/xml"))).toBe(false);
  });

  it.each(["html", "xhtml"])("preserves HTML controls, entities, style text and SVG namespaces in %s", type => {
    const doc = type === "xhtml" ? xhtml() : document.implementation.createHTMLDocument("");
    setHtmlContent(doc.body, '<button hidden disabled>A &amp; B&nbsp;C</button><input type="checkbox" checked><br><style>p::before { content: "< & >"; }</style><svg viewBox="0 0 24 24"><path d="M0 0h24v24z"/></svg>');
    const button = doc.querySelector<HTMLButtonElement>("button")!;
    expect(button.namespaceURI).toBe("http://www.w3.org/1999/xhtml");
    expect(button.hidden).toBe(true);
    expect(button.disabled).toBe(true);
    expect(button.textContent).toBe("A & B\u00a0C");
    expect(doc.querySelector<HTMLInputElement>("input")!.checked).toBe(true);
    expect(doc.querySelector("style")!.textContent).toContain('"< & >"');
    expect(doc.querySelector("svg")!.namespaceURI).toBe("http://www.w3.org/2000/svg");
    expect(doc.querySelector("path")!.namespaceURI).toBe("http://www.w3.org/2000/svg");
  });

  it("supports shadow roots and appending controls without replacing existing listeners", () => {
    const doc = xhtml();
    const host = doc.createElement("div"), root = host.attachShadow({ mode: "open" });
    setHtmlContent(root, '<input type="file" hidden><button>Open</button>');
    const button = root.querySelector("button")!;
    let clicks = 0; button.addEventListener("click", () => clicks++);
    root.append(htmlFragment('<span hidden>More &nbsp; controls</span>', doc));
    button.click();
    expect(clicks).toBe(1);
    expect(root.querySelector<HTMLInputElement>("input")!.type).toBe("file");
    expect(root.querySelector("span")!.ownerDocument).toBe(doc);
    expect(root.querySelector<HTMLSpanElement>("span")!.hidden).toBe(true);
  });
});
