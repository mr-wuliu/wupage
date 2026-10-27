import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import config from "./runtime.json";
import { OCR_MODELS } from "../../src/shared/ocr";

export async function verifyOcrRuntime(root: string): Promise<string> {
  const runtime = resolve(root, "vendor/ocr");
  const manifest = JSON.parse(await readFile(resolve(runtime, "manifest.json"), "utf8")) as {
    inputs: Record<string, string>;
    files: Record<string, { bytes: number; sha256: string }>;
  };
  const packageJson = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
  if (packageJson.dependencies["onnxruntime-web"] !== config.onnxruntime.version) {
    throw new Error("The OCR JavaScript and custom ONNX Runtime versions must match.");
  }
  if (packageJson.dependencies["@paddleocr/paddleocr-js"] !== config.paddleocrVersion) {
    throw new Error("PaddleOCR changed. Review and rebuild the custom OpenCV bindings.");
  }
  if (JSON.stringify(OCR_MODELS.map(({ name, bytes, sha256 }) => ({ name, bytes, sha256 }))) !== JSON.stringify(config.models)) {
    throw new Error("OCR model pins changed. Rebuild the custom runtimes before packaging.");
  }
  for (const file of ["build/ocr/runtime.json", "build/ocr/opencv.config.py", "build/ocr/build.py", "build/ocr/requirements.txt"]) {
    const expected = manifest.inputs[file];
    const actual = createHash("sha256").update(await readFile(resolve(root, file))).digest("hex");
    if (actual !== expected) throw new Error(`OCR build input changed: ${file}. Rebuild the custom runtimes.`);
  }
  for (const file of ["opencv.js", "opencv.wasm", "ort-wasm-simd-threaded.mjs", "ort-wasm-simd-threaded.wasm",
    "opencv-LICENSE.txt", "opencv-NOTICES.txt", "onnxruntime-LICENSE.txt", "onnxruntime-NOTICES.txt", "required-operators.config"]) {
    const expected = manifest.files[file];
    const bytes = await readFile(resolve(runtime, file));
    if (!expected || bytes.length !== expected.bytes || createHash("sha256").update(bytes).digest("hex") !== expected.sha256) {
      throw new Error(`OCR runtime integrity check failed: ${file}`);
    }
  }
  return runtime;
}
