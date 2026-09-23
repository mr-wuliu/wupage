import { PaddleOCR } from "@paddleocr/paddleocr-js";
import { OCR_MODELS } from "../shared/ocr";

let engine: Awaited<ReturnType<typeof PaddleOCR.create>> | undefined;
window.addEventListener("message", (event) => {
  if (event.source !== parent || event.data?.target !== "wupage-ocr-engine") return;
  const { id, action, data } = event.data;
  void (async () => {
    if (action === "init") {
      engine = await PaddleOCR.create({
        textDetectionModelName: OCR_MODELS[0].name,
        textRecognitionModelName: OCR_MODELS[1].name,
        worker: false,
        fetch: (async (input: RequestInfo | URL) => {
          const url = input instanceof Request ? input.url : String(input);
          const index = OCR_MODELS.findIndex((model) => model.url === url);
          if (index < 0) throw new Error("不允许加载未知模型。");
          return new Response(data.models[index]);
        }) as typeof fetch,
        ortOptions: { backend: "wasm", wasmPaths: data.wasmPath, numThreads: 1, proxy: false },
        textRecognitionBatchSize: 1
      });
      return null;
    }
    if (!engine || action !== "recognize") throw new Error("OCR 尚未初始化。");
    const bitmap = await createImageBitmap(await (await fetch(data.dataUrl)).blob());
    try {
      const [result] = await engine.predict(bitmap, { textDetLimitSideLen: 1600, textDetLimitType: "max", textRecScoreThresh: 0.6 });
      return result.items;
    } finally { bitmap.close(); }
  })().then(
    (result) => parent.postMessage({ target: "wupage-ocr-result", id, result }, "*"),
    (error: unknown) => parent.postMessage({ target: "wupage-ocr-result", id, error: error instanceof Error ? error.message : String(error) }, "*")
  );
});
