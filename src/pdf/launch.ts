export interface PdfLaunchOptions {
  url: string | null;
  autoTranslate: boolean;
}

export function isLikelyPdfUrl(value: string | undefined): boolean {
  if (!value) return false;
  try {
    const url = new URL(value);
    const pathname = decodeURIComponent(url.pathname);
    const pdfPath = pathname.toLowerCase().endsWith(".pdf");
    if (url.protocol === "file:") return pdfPath;
    // arXiv serves PDFs from /pdf/<id> without a file extension, including
    // older identifiers with an archive prefix such as hep-th/9901001.
    const arxivPdf = ["arxiv.org", "www.arxiv.org", "export.arxiv.org"].includes(url.hostname)
      && /^\/pdf\/[^/]+(?:\/[^/]+)?\/?$/u.test(pathname);
    return (url.protocol === "http:" || url.protocol === "https:")
      && (pdfPath || arxivPdf || url.search.toLowerCase().includes(".pdf"));
  } catch {
    return false;
  }
}

export function pdfRedirectKey(tabId: number): string {
  return `wupage.pdf-redirect.${tabId}`;
}

export async function getPdfTabSource(tabId: number | undefined, url: string): Promise<string> {
  if (tabId === undefined || !/^https?:/u.test(url)) return url;
  const key = pdfRedirectKey(tabId);
  const stored = await chrome.storage?.session?.get(key).catch(() => undefined);
  const redirect = stored?.[key] as { documentId: string; source: string } | undefined;
  if (redirect) {
    const frame = await chrome.webNavigation?.getFrame({ tabId, frameId: 0 }).catch(() => undefined);
    if (frame && frame.documentId === redirect.documentId && frame.url.split("#")[0] === url.split("#")[0]) return redirect.source;
  }
  return url;
}

export function getExtensionDetailsUrl(extensionId: string, userAgent: string): string {
  if (/Firefox\//.test(userAgent)) return "about:addons";
  const scheme = /Edg\//.test(userAgent) ? "edge" : "chrome";
  return `${scheme}://extensions/?id=${encodeURIComponent(extensionId)}`;
}

export function getPdfLaunchOptions(href: string): PdfLaunchOptions {
  const parameters = new URL(href).searchParams;
  return {
    url: parameters.get("url"),
    autoTranslate: parameters.get("translate") !== "0"
  };
}

export async function openPdfWorkspaceInNewTab(
  createTab: (properties: { url: string }) => Promise<unknown>,
  getExtensionUrl: (path: string) => string
): Promise<void> {
  await createTab({ url: getExtensionUrl("pdf.html") });
}
