import { afterEach, describe, expect, it } from "vitest";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { verifyOcrRuntime } from "../build/ocr/verify";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function fixture(): Promise<string> {
  const root = await mkdtemp(resolve(tmpdir(), "wupage-ocr-integrity-"));
  roots.push(root);
  await cp("vendor/ocr", resolve(root, "vendor/ocr"), { recursive: true });
  await cp("build/ocr", resolve(root, "build/ocr"), { recursive: true });
  await cp("package.json", resolve(root, "package.json"));
  return root;
}

describe("custom OCR artifacts", () => {
  it("ships verified, valid WASM libraries for the pinned models and JavaScript API", async () => {
    const runtime = await verifyOcrRuntime(process.cwd());
    for (const file of ["opencv.wasm", "ort-wasm-simd-threaded.wasm"]) {
      const bytes = await readFile(resolve(runtime, file));
      expect(WebAssembly.validate(bytes)).toBe(true);
    }
  });

  it("rejects a corrupted executable before it can be bundled", async () => {
    const root = await fixture();
    await writeFile(resolve(root, "vendor/ocr/opencv.wasm"), new Uint8Array([0, 97, 115, 109]));
    await expect(verifyOcrRuntime(root)).rejects.toThrow("integrity check failed: opencv.wasm");
  });

  it("requires rebuilding when the interface allowlist changes", async () => {
    const root = await fixture();
    await writeFile(resolve(root, "build/ocr/opencv.config.py"), "white_list = {}\n");
    await expect(verifyOcrRuntime(root)).rejects.toThrow("OCR build input changed");
  });

  it("requires JavaScript and WASM from the same ONNX Runtime release", async () => {
    const root = await fixture();
    const pkg = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
    pkg.dependencies["onnxruntime-web"] = "1.31.0";
    await writeFile(resolve(root, "package.json"), JSON.stringify(pkg));
    await expect(verifyOcrRuntime(root)).rejects.toThrow("versions must match");
  });
});
