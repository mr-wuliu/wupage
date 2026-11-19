import { afterEach, describe, expect, it, vi } from "vitest";
import { installPdfNavigation } from "../src/background/pdf-navigation";
import { getPdfTabSource } from "../src/pdf/launch";

function mockNavigation() {
  const before = { addListener: vi.fn() }, commit = { addListener: vi.fn() };
  const error = { addListener: vi.fn() }, removed = { addListener: vi.fn() };
  const session: Record<string, unknown> = {};
  const getFrame = vi.fn();
  vi.stubGlobal("chrome", {
    webNavigation: { onBeforeNavigate: before, onCommitted: commit, onErrorOccurred: error, getFrame },
    tabs: { onRemoved: removed },
    storage: { session: {
      set: async (data: Record<string, unknown>) => Object.assign(session, data),
      get: async (key: string) => ({ [key]: session[key] }),
      remove: async (key: string) => { delete session[key]; }
    } }
  });
  installPdfNavigation();
  return { begin: before.addListener.mock.calls[0][0], commit: commit.addListener.mock.calls[0][0],
    fail: error.addListener.mock.calls[0][0], close: removed.addListener.mock.calls[0][0], getFrame, session };
}

describe("redirected PDF navigation", () => {
  afterEach(() => vi.unstubAllGlobals());
  const tabId = 17;
  const original = "https://publisher.example/download/book.pdf";
  const signed = "https://cdn.example/book.pdf?X-Amz-Signature=short-lived";
  const start = { tabId, frameId: 0, url: original };
  const destination = { tabId, frameId: 0, documentId: "book", url: signed, transitionQualifiers: ["server_redirect"] };

  it("retrieves the publisher link after an HTTP redirect only for the same PDF document and tab", async () => {
    const nav = mockNavigation();
    nav.begin(start);
    nav.begin({ ...start, url: "https://other.example/embedded.pdf", frameId: 1 });
    nav.commit(destination);
    nav.getFrame.mockResolvedValue(destination);
    expect(await getPdfTabSource(tabId, signed + "#page=3")).toBe(original);
    expect(await getPdfTabSource(tabId + 1, signed)).toBe(signed);
    expect(await getPdfTabSource(tabId, signed + "2")).toBe(signed + "2");
    nav.getFrame.mockResolvedValue({ ...destination, documentId: "replacement" });
    expect(await getPdfTabSource(tabId, signed)).toBe(signed);
    expect(JSON.stringify(nav.session)).not.toContain("short-lived");
    nav.close(tabId);
    expect(nav.session).toEqual({});
  });

  it("discards abandoned navigations, direct visits and client-side redirects", async () => {
    const nav = mockNavigation();
    nav.begin(start);
    nav.fail(start);
    nav.commit(destination);
    expect(nav.session).toEqual({});
    nav.begin(start);
    nav.commit({ ...destination, transitionQualifiers: ["client_redirect"] });
    expect(nav.session).toEqual({});
    nav.begin(start);
    nav.commit(destination);
    nav.begin({ ...start, url: signed });
    nav.commit({ ...destination, transitionQualifiers: [] });
    expect(await getPdfTabSource(tabId, signed)).toBe(signed);
    expect(nav.session).toEqual({});
  });
});
