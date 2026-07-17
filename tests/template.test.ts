import { describe, expect, it } from "vitest";
import { readPath, renderTemplate } from "../src/background/template";

describe("renderTemplate", () => {
  it("renders string and JSON placeholders", () => {
    expect(
      renderTemplate("{{targetLang}}: {{json texts}}", {
        targetLang: "zh-CN",
        sourceLang: "auto",
        texts: ["hello", "world"]
      })
    ).toBe('zh-CN: ["hello","world"]');
  });
});

describe("readPath", () => {
  it("reads nested object and array paths", () => {
    expect(readPath({ data: { translations: ["你好"] } }, "data.translations.0")).toBe("你好");
  });
});
