const marker = /⟪WUPAGE(OPEN|CLOSE)(\d+)⟫/gu;

export function toStructuredHTML(text: string): string | undefined {
  if (!text.includes("⟪WUPAGEOPEN")) return undefined;
  return text.replace(/&/gu, "&amp;").replace(/</gu, "&lt;").replace(/>/gu, "&gt;")
    .replace(marker, (_match, kind: string, id: string) => kind === "OPEN"
      ? `<span data-wupage-inline="${id}">` : "</span>");
}

export function fromStructuredHTML(html: string): string | undefined {
  const document = new DOMParser().parseFromString(html, "text/html");
  const read = (node: Node): string => {
    if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? "";
    if (!(node instanceof Element) || node.localName !== "span" || node.attributes.length !== 1
      || !/^\d+$/u.test(node.getAttribute("data-wupage-inline") ?? "")) throw new Error("Unexpected translated markup");
    const id = node.getAttribute("data-wupage-inline");
    return `⟪WUPAGEOPEN${id}⟫${[...node.childNodes].map(read).join("")}⟪WUPAGECLOSE${id}⟫`;
  };
  try { return [...document.body.childNodes].map(read).join(""); }
  catch { return undefined; }
}
