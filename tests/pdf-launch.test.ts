import { describe, expect, it, vi } from "vitest";
import { getPdfLaunchOptions, openPdfWorkspaceInNewTab } from "../src/pdf/launch";

describe("PDF launch options", () => {
  it("recognizes popup-initiated automatic translation", () => {
    expect(getPdfLaunchOptions(
      "chrome-extension://extension/pdf.html?url=https%3A%2F%2Fexample.com%2Fpaper.pdf&translate=1"
    )).toEqual({
      url: "https://example.com/paper.pdf",
      autoTranslate: true
    });
  });

  it("keeps manually opened PDF workspaces idle", () => {
    expect(getPdfLaunchOptions("chrome-extension://extension/pdf.html")).toEqual({
      url: null,
      autoTranslate: false
    });
  });

  it("opens another blank workspace in a new tab without replacing the current document", async () => {
    const createTab = vi.fn(async () => undefined);

    await openPdfWorkspaceInNewTab(
      createTab,
      (path) => `chrome-extension://extension/${path}`
    );

    expect(createTab).toHaveBeenCalledWith({
      url: "chrome-extension://extension/pdf.html"
    });
  });
});
