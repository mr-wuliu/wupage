const HTML_NAMESPACE = "http://www.w3.org/1999/xhtml";

/** Also accepts browser-generated HTML image/text viewers with a non-HTML MIME type. */
export function supportsHtmlContent(doc: Document = document): boolean {
  return doc.createElement("div").namespaceURI === HTML_NAMESPACE;
}

/** Parse extension-owned markup as HTML, including when the host is XHTML. Not a sanitizer. */
export function htmlFragment(markup: string, doc: Document = document): DocumentFragment {
  const parser = doc.contentType === "text/html" ? doc : doc.implementation.createHTMLDocument("");
  const template = parser.createElement("template");
  template.innerHTML = markup;
  return parser === doc ? template.content : doc.importNode(template.content, true);
}

export function setHtmlContent(target: Element | ShadowRoot, markup: string): void {
  if (target.ownerDocument.contentType === "text/html") target.innerHTML = markup;
  else target.replaceChildren(htmlFragment(markup, target.ownerDocument));
}
