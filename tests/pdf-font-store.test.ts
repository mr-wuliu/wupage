import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { importPdfFont, installPdfFont, PDF_FONT_CACHE, readPdfFont, removePdfFont } from "../src/pdf/font-store";

vi.mock("../public/pdf-fonts/font-metadata.json", () => ({ default: { font: {
  source: "https://fonts.example/font.otf", file: "test.otf", bytes: 3,
  sha256: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
} } }));
let entries: Map<string, Response>;
beforeEach(() => {
  entries = new Map();
  vi.stubGlobal("caches", {
    has: async () => entries.size > 0,
    delete: async () => { entries.clear(); return true; },
    open: async () => ({
      match: async (key: string) => entries.get(key)?.clone(),
      put: async (key: string, value: Response) => { entries.set(key, value.clone()); },
      delete: async (key: string) => entries.delete(key)
    })
  });
  vi.stubGlobal("navigator", { locks: { request: async (_name: string, options: unknown, task?: () => unknown) => {
    return task ? task() : (options as () => unknown)();
  } } });
  vi.stubGlobal("fetch", vi.fn(async () => new Response("abc")));
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("optional PDF export font storage", () => {
  it("imports the exact pinned font offline and reuses it for later exports", async () => {
    await expect(importPdfFont(new Blob(["abc"]), new AbortController().signal)).resolves.toEqual(new TextEncoder().encode("abc"));
    expect(fetch).not.toHaveBeenCalled();
    expect(new TextDecoder().decode(await readPdfFont())).toBe("abc");
    await installPdfFont(new AbortController().signal, vi.fn());
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each(["ab", "abd", "abcdef"])("rejects a wrong offline font without replacing an installed one: %s", async text => {
    await importPdfFont(new Blob(["abc"]), new AbortController().signal);
    await expect(importPdfFont(new Blob([text]), new AbortController().signal)).rejects.toThrow();
    expect(new TextDecoder().decode(await readPdfFont())).toBe("abc");
    expect(fetch).not.toHaveBeenCalled();
  });
  it("does not store a file read that completes after cancellation", async () => {
    const controller = new AbortController();
    const file = new Blob(["abc"]);
    vi.spyOn(file, "arrayBuffer").mockImplementation(async () => {
      controller.abort(); return new TextEncoder().encode("abc").buffer;
    });
    await expect(importPdfFont(file, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(entries.size).toBe(0);
  });
  it("does not write after cancellation while opening the cache", async () => {
    const controller = new AbortController();
    const open = caches.open.bind(caches);
    vi.spyOn(caches, "open").mockImplementation(async name => {
      controller.abort(); return open(name);
    });
    await expect(importPdfFont(new Blob(["abc"]), controller.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(entries.size).toBe(0);
  });
  it("reports storage errors without misidentifying them as download failures", async () => {
    vi.spyOn(caches, "open").mockRejectedValue(new TypeError("Cache is unavailable"));
    await expect(installPdfFont(new AbortController().signal, vi.fn())).rejects.toThrow("Cache is unavailable");
    expect(entries.size).toBe(0);
  });
  it("reports the download host and an offline recovery path on connection failure", async () => {
    vi.mocked(fetch).mockRejectedValue(new TypeError("Failed to fetch"));
    await expect(installPdfFont(new AbortController().signal, vi.fn())).rejects.toThrow("fonts.example");
    await expect(installPdfFont(new AbortController().signal, vi.fn())).rejects.toThrow("从文件安装");
    expect(entries.size).toBe(0);
  });
  it("does not download on lookup, and reuses verified cached data offline", async () => {
    expect(await readPdfFont()).toBeUndefined();
    expect(fetch).not.toHaveBeenCalled();
    const progress = vi.fn();
    await installPdfFont(new AbortController().signal, progress);
    expect(progress).toHaveBeenLastCalledWith(3);
    expect(fetch).toHaveBeenCalledWith("https://fonts.example/font.otf", expect.objectContaining({ credentials: "omit", cache: "no-store" }));
    vi.mocked(fetch).mockRejectedValue(new Error("offline"));
    expect(new TextDecoder().decode(await readPdfFont())).toBe("abc");
    expect(new TextDecoder().decode(await installPdfFont(new AbortController().signal, vi.fn()))).toBe("abc");
    expect(fetch).toHaveBeenCalledTimes(1);
    await removePdfFont();
    expect(await readPdfFont()).toBeUndefined();
    expect(entries.size).toBe(0);
  });
  it.each(["ab", "abd", "abcdef"])("rejects incomplete, corrupted or oversized data: %s", async (body) => {
    vi.mocked(fetch).mockResolvedValue(new Response(body));
    await expect(installPdfFont(new AbortController().signal, vi.fn())).rejects.toThrow();
    expect(entries.size).toBe(0);
  });
  it("discards corrupted cached data instead of passing it to the PDF renderer", async () => {
    await installPdfFont(new AbortController().signal, vi.fn());
    entries.set([...entries.keys()][0], new Response("abd"));
    expect(await readPdfFont()).toBeUndefined();
    expect(entries.size).toBe(0);
  });
  it("leaves no installed font after cancellation or HTTP failure", async () => {
    const controller = new AbortController(); controller.abort();
    await expect(installPdfFont(controller.signal, vi.fn())).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
    vi.mocked(fetch).mockResolvedValue(new Response("", { status: 503 }));
    await expect(installPdfFont(new AbortController().signal, vi.fn())).rejects.toThrow("503");
    expect(await readPdfFont()).toBeUndefined();
    expect(PDF_FONT_CACHE).toContain("pdf-export-fonts");
  });
});
