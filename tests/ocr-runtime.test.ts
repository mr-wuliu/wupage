import { describe, expect, it, vi } from "vitest";
import { env, InferenceSession as OrtSession } from "onnxruntime-web/wasm";
import { InferenceSession } from "../src/ocr/ort-runtime";

vi.mock("onnxruntime-web/wasm", () => ({ env: {}, InferenceSession: { create: vi.fn() } }));

describe("OCR runtime logging", () => {
  it("keeps execution settings while setting environment and session logs to errors", async () => {
    const model = new Uint8Array([1, 2, 3]);
    const options = { executionProviders: ["wasm"], graphOptimizationLevel: "all" as const };
    await InferenceSession.create(model, options);
    expect(env.logLevel).toBe("error");
    expect(OrtSession.create).toHaveBeenCalledWith(model, { ...options, logSeverityLevel: 3 });
    expect(options).not.toHaveProperty("logSeverityLevel");
  });

  it("still propagates actual model loading failures", async () => {
    const failure = new Error("Invalid model");
    vi.mocked(OrtSession.create).mockRejectedValueOnce(failure);
    await expect(InferenceSession.create(new Uint8Array())).rejects.toBe(failure);
  });
});
