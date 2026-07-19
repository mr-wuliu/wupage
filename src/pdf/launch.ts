export interface PdfLaunchOptions {
  url: string | null;
  autoTranslate: boolean;
}

export function getPdfLaunchOptions(href: string): PdfLaunchOptions {
  const parameters = new URL(href).searchParams;
  return {
    url: parameters.get("url"),
    autoTranslate: parameters.get("translate") === "1"
  };
}

export async function openPdfWorkspaceInNewTab(
  createTab: (properties: { url: string }) => Promise<unknown>,
  getExtensionUrl: (path: string) => string
): Promise<void> {
  await createTab({ url: getExtensionUrl("pdf.html") });
}
