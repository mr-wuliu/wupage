// PaddleOCR 0.4.2 does not expose ONNX session logging options. Its import is
// routed here when bundling the isolated OCR sandbox, without changing the SDK.
export * from "onnxruntime-web/wasm";
import { env, InferenceSession as OrtSession } from "onnxruntime-web/wasm";

env.logLevel = "error";

export const InferenceSession = {
  // PaddleOCR creates its detection and recognition sessions from Uint8Array.
  create(model: Uint8Array, options?: OrtSession.SessionOptions): Promise<OrtSession> {
    return OrtSession.create(model, { ...options, logSeverityLevel: 3 });
  }
};
