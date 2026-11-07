import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { downloadLocalModel, importModelFiles, localModelStates, readLocalModel, removeLocalModel, verifyModelBytes } from "../src/local/model-store";
import { LOCAL_MODELS, type ModelFile } from "../src/local/models";

vi.mock("../src/local/catalog.json", () => ({ default: [{ id: "en-es", from: "en", to: "es", label: "英语 → 西班牙语", version: "1", files: [] }] }));

let entries: Map<string, Response>;
let locked: boolean;
const digest = async (bytes: Uint8Array) => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>)), (byte) => byte.toString(16).padStart(2, "0")).join("");
const bytes = (text: string) => new TextEncoder().encode(text);
const asFile = (name: string, data: Uint8Array) => ({ name, size: data.length, arrayBuffer: async () => data.slice().buffer }) as File;

beforeEach(async () => {
  entries = new Map(); locked = false;
  LOCAL_MODELS.splice(1);
  LOCAL_MODELS[0].files = await Promise.all(["abc", "def"].map(async (text, index): Promise<ModelFile> => ({
    role: index ? "vocab" : "model", name: `${index}.bin`, bytes: 3,
    sha256: await digest(bytes(text)), url: `https://models.example/${index}`
  })));
  vi.stubGlobal("caches", { open: async () => ({
    match: async (key: string) => entries.get(key)?.clone(),
    put: async (key: string, value: Response) => { entries.set(key, value.clone()); },
    delete: async (key: string) => entries.delete(key)
  }) });
  vi.stubGlobal("navigator", { locks: { request: async (_name: string, _options: unknown, callback: (lock: object | null) => unknown) => {
    if (locked) return callback(null);
    locked = true;
    try { return await callback({}); } finally { locked = false; }
  } } });
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("Bergamot model storage and weak networks", () => {
  it("never fetches during status checks or inference reads, and describes missing models", async () => {
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    expect((await localModelStates())[0].state).toBe("missing");
    await expect(readLocalModel("en-es")).rejects.toThrow("下载或导入");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("verifies downloads, reuses complete files, and removes the selected model", async () => {
    const fetch = vi.fn(async (url: string) => new Response(url.endsWith("0") ? "abc" : "def"));
    vi.stubGlobal("fetch", fetch);
    await downloadLocalModel("en-es", new AbortController().signal, vi.fn());
    expect((await localModelStates())[0]).toMatchObject({ state: "ready", downloaded: 6, total: 6 });
    expect(new TextDecoder().decode((await readLocalModel("en-es")).model)).toBe("abc");
    await downloadLocalModel("en-es", new AbortController().signal, vi.fn());
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch).toHaveBeenCalledWith("https://models.example/0", expect.objectContaining({ credentials: "omit", cache: "no-store" }));
    await removeLocalModel("en-es");
    expect((await localModelStates())[0].state).toBe("missing");
  });

  it.each(["http", "network", "timeout"])("reports the file and cause of a %s failure after bounded retries", async (failure) => {
    vi.useFakeTimers();
    const fetch = vi.fn(async (_url: string, options: RequestInit) => {
      if (failure === "http") return new Response(null, { status: 503 });
      if (failure === "network") throw new TypeError("Failed to fetch");
      return new Promise<Response>((_resolve, reject) => options.signal!.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true }));
    });
    vi.stubGlobal("fetch", fetch);
    const result = downloadLocalModel("en-es", new AbortController().signal, vi.fn()).catch(error => error);
    await vi.runAllTimersAsync();
    const error = await result;
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toContain("0.bin");
    expect(error.message).toContain(failure === "http" ? "HTTP 503" : "models.example");
    expect(error.message).toContain(failure === "timeout" ? "超时" : failure === "network" ? "Failed to fetch" : "下载失败");
    expect(error.message).not.toContain("__MSG_");
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("finishes checksum verification locally if cancellation occurs after all bytes were checkpointed", async () => {
    const data = new Uint8Array(1024 * 1024 + 19).fill(97);
    const file = { ...LOCAL_MODELS[0].files[0], bytes: data.length, sha256: await digest(data) };
    LOCAL_MODELS[0].files = [file];
    const controller = new AbortController();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(data)));
    await expect(downloadLocalModel("en-es", controller.signal, (offset) => {
      if (offset >= 1024 * 1024) controller.abort();
    })).rejects.toThrow();
    expect((await localModelStates())[0].state).toBe("partial");
    const fetch = vi.fn();
    // The complete file can be checkpointed before cancellation. Revalidation
    // finishes locally without a redundant request in that case.
    vi.stubGlobal("fetch", fetch);
    await downloadLocalModel("en-es", new AbortController().signal, vi.fn());
    expect(fetch).not.toHaveBeenCalled();
    expect((await localModelStates())[0].state).toBe("ready");
    expect((await readLocalModel("en-es")).model.byteLength).toBe(data.length);
  });

  it.each([true, false])("resumes an interrupted stream without corrupting data (server supports Range: %s)", async (rangeSupported) => {
    const data = new Uint8Array(1024 * 1024 + 19).fill(97);
    LOCAL_MODELS[0].files = [{ ...LOCAL_MODELS[0].files[0], bytes: data.length, sha256: await digest(data) }];
    let reads = 0;
    const fetch = vi.fn(async (_url: string, options: RequestInit) => {
      if (fetch.mock.calls.length === 1) return new Response(new ReadableStream({ pull(stream) {
        if (reads++ === 0) stream.enqueue(data.slice(0, 1024 * 1024));
        else stream.error(new Error("Network disconnected"));
      } }));
      expect(options.headers).toEqual({ Range: "bytes=1048576-" });
      return rangeSupported
        ? new Response(data.slice(1024 * 1024), { status: 206, headers: { "content-range": `bytes 1048576-${data.length - 1}/${data.length}` } })
        : new Response(data);
    });
    vi.stubGlobal("fetch", fetch);
    await downloadLocalModel("en-es", new AbortController().signal, vi.fn());
    expect(fetch).toHaveBeenCalledTimes(2);
    expect((await localModelStates())[0].state).toBe("ready");
    expect(Buffer.from((await readLocalModel("en-es")).model).equals(Buffer.from(data))).toBe(true);
  });

  it("accepts verified offline files with CDN filenames, supports partial imports, and rejects corruption", async () => {
    expect(await importModelFiles("en-es", [asFile("uuid.bin", bytes("abc"))])).toBe(1);
    expect((await localModelStates())[0].state).toBe("partial");
    await expect(importModelFiles("en-es", [asFile("1.bin", bytes("xyz"))])).rejects.toThrow("校验失败");
    await importModelFiles("en-es", [asFile("1.bin", bytes("def"))]);
    expect((await localModelStates())[0].state).toBe("ready");
    await expect(verifyModelBytes(LOCAL_MODELS[0].files[0], bytes("ab").buffer)).rejects.toThrow("大小不匹配");
  });

  it("prevents concurrent writes from separate settings windows", async () => {
    locked = true;
    await expect(importModelFiles("en-es", [asFile("0.bin", bytes("abc"))])).rejects.toThrow("另一窗口");
    expect(entries.size).toBe(0);
  });

  it("marks a corrupted cached file missing so it can be downloaded again", async () => {
    await importModelFiles("en-es", [asFile("0.bin", bytes("abc")), asFile("1.bin", bytes("def"))]);
    const key = `https://wupage.invalid/bergamot/${LOCAL_MODELS[0].files[0].sha256}`;
    const headers = entries.get(key)!.headers;
    entries.set(key, new Response("xyz", { headers }));
    await expect(readLocalModel("en-es")).rejects.toThrow("校验失败");
    expect((await localModelStates())[0].state).toBe("partial");
  });

  it("keeps vocabulary files shared by another installed model", async () => {
    LOCAL_MODELS.push({ ...LOCAL_MODELS[0], id: "es-en" });
    await importModelFiles("en-es", [asFile("0.bin", bytes("abc")), asFile("1.bin", bytes("def"))]);
    await removeLocalModel("en-es");
    expect((await localModelStates())[1].state).toBe("ready");
  });
});
