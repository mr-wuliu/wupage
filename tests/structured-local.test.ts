// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { fromStructuredHTML, toStructuredHTML } from "../src/local/structured-html";
import { LocalTranslationEngine } from "../src/local/engine";
import { getLocalRoute } from "../src/local/models";
import { normalizeProtectedText } from "../src/shared/protected-text";

vi.mock("../src/local/model-store", () => ({ readLocalModel: async () => ({
  model: new ArrayBuffer(3), lex: new ArrayBuffer(3), vocab: new ArrayBuffer(3)
}) }));
afterEach(() => vi.unstubAllGlobals());

it("uses HTML alignment only for generated format scopes and escapes all page text", () => {
  expect(toStructuredHTML("Use <b>literal</b> & text.")).toBeUndefined();
  const source = "Use <literal> & ⟪WUPAGEOPEN0⟫important⟪WUPAGECLOSE0⟫ text.";
  const html = toStructuredHTML(source)!;
  expect(html).toBe('Use &lt;literal&gt; &amp; <span data-wupage-inline="0">important</span> text.');
  expect(fromStructuredHTML(html)).toBe(source);
  expect(fromStructuredHTML('<span data-wupage-inline="0" onclick="bad()">Text</span>')).toBeUndefined();
  expect(fromStructuredHTML('<script>bad()</script><b>Text</b>')).toBeUndefined();
});

it("round-trips nested and reordered inline IDs through the real local worker protocol", async () => {
  const sent: Array<{ name: string; args: unknown[] }> = [];
  const source = "Read ⟪WUPAGEOPEN0⟫this⟪WUPAGECLOSE0⟫ and ⟪WUPAGEOPEN1⟫that⟪WUPAGECLOSE1⟫.";
  class FakeWorker {
    onmessage?: (event: { data: unknown }) => void;
    terminate = vi.fn();
    postMessage(message: { id: number; name: string; args: unknown[] }) {
      sent.push(message);
      queueMicrotask(() => this.onmessage?.({ data: { id: message.id, result: message.name === "translate"
        ? [{ target: { text: '<span data-wupage-inline="1">那个</span>和<span data-wupage-inline="0">这个</span>。' } }]
        : null } }));
    }
  }
  vi.stubGlobal("chrome", { runtime: { getURL: (path: string) => path } });
  vi.stubGlobal("Worker", FakeWorker);
  const engine = new LocalTranslationEngine();
  const [translated] = await engine.translate(getLocalRoute("en", "zh-CN"), [source]);
  expect(sent.find(entry => entry.name === "translate")!.args).toMatchObject([{ texts: [{ html: true, qualityScores: false }] }]);
  expect(translated).toBe("⟪WUPAGEOPEN1⟫那个⟪WUPAGECLOSE1⟫和⟪WUPAGEOPEN0⟫这个⟪WUPAGECLOSE0⟫。");
  expect(normalizeProtectedText(source, translated)).toBe(translated);
  engine.release();
});
