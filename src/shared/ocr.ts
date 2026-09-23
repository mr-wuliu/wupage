export const OCR_CACHE = "wupage-ocr-ppocrv5-v1";
export const OCR_MODELS = [
  { name: "PP-OCRv5_mobile_det", bytes: 4843520, sha256: "781056046c9ed77a15c94681605db6a0f62317c2e9cce6931c71da2478d4bc30" },
  { name: "PP-OCRv5_mobile_rec", bytes: 16701440, sha256: "f7e792bc836f36e7ef895ad47c426d75b0b75b1650caa6d63fe9418441ffba8c" }
].map((model) => ({ ...model, url: `https://paddle-model-ecology.bj.bcebos.com/paddlex/official_inference_model/paddle3.0.0/${model.name}_onnx_infer.tar` }));
export const OCR_DOWNLOAD_BYTES = OCR_MODELS.reduce((sum, model) => sum + model.bytes, 0);
export const OCR_DESCRIPTION = "启用前需额外下载约 20.5 MB 的 OCR 模型，保存在此浏览器。点击图片上的翻译按钮时才识别；识别在本地完成，文字交给当前翻译服务。";
export interface OcrStatus {
  state: "missing" | "installing" | "installed" | "error";
  downloaded: number;
  total: number;
  revision?: string;
  error?: string;
}
export interface OcrLine { poly: [number, number][]; text: string; score: number }
export interface OcrRecognition { lines: OcrLine[]; revision: string }
