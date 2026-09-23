import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { commitModels, downloadModels, installedRevision, readModelBuffers } from "../src/ocr/model-store";
vi.mock("../src/shared/ocr", () => ({
  OCR_CACHE: "test-ocr",
  OCR_MODELS: [{ name: "test", url: "https://models.example/test", bytes: 3, sha256: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad" }]
}));
let entries: Map<string, Response>;
let exists: boolean;
beforeEach(() => {
  entries = new Map(); exists = false;
  vi.stubGlobal("caches", {
    has: async () => exists,
    delete: async () => { entries.clear(); exists = false; return true; },
    open: async () => { exists = true; return {
      match: async (key: string) => entries.get(key)?.clone(),
      put: async (key: string, value: Response) => { entries.set(key, value.clone()); }
    }; }
  });
});
afterEach(() => vi.unstubAllGlobals());
describe("optional OCR model storage", () => {
  it("does not mark downloads installed before runtime verification and a commit", async () => {
    const fetchMock = vi.fn(async () => new Response("abc"));
    vi.stubGlobal("fetch", fetchMock);
    const progress = vi.fn();
    await downloadModels(progress);
    expect(progress).toHaveBeenLastCalledWith(3);
    expect(await installedRevision()).toBeUndefined();
    expect(new TextDecoder().decode((await readModelBuffers())[0])).toBe("abc");
    const revision = await commitModels();
    expect(await installedRevision()).toBe(revision);
    expect(fetchMock).toHaveBeenCalledWith("https://models.example/test", expect.objectContaining({ credentials: "omit", cache: "no-store" }));
  });
  it.each(["ab", "abd", "abcdef"])("rolls back incomplete or corrupted downloads: %s", async (body) => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(body)));
    await expect(downloadModels(vi.fn())).rejects.toThrow("校验失败");
    expect(await installedRevision()).toBeUndefined();
    expect(entries.size).toBe(0);
  });
  it("detects a missing model even when an installation receipt exists", async () => {
    await commitModels();
    expect(await installedRevision()).toBeUndefined();
  });
});
