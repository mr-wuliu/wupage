import { describe, expect, it, vi } from "vitest";
import { normalizeProtectedText, protectedTextTokens } from "../src/shared/protected-text";
import { translateTextWithRecovery } from "../src/background/protected-translation";
import type { TranslateBatchRequest } from "../src/shared/types";

describe("protected formula token normalization", () => {
  it.each(["⟪WUPAGE12⟫", "《 wupage 12 》", "[WUPAGE12]", "{{WUPAGE12}}", "〈WUPAGE 012〉"])("normalizes %s without changing prose", (token) => {
    expect(normalizeProtectedText("Let ⟪WUPAGE12⟫ be fixed.", `设 ${token} 为常数。`)).toBe("设 ⟪WUPAGE12⟫ 为常数。");
  });

  it("allows reordering but rejects missing, repeated and substituted IDs", () => {
    const source = "Compare ⟪WUPAGE1⟫ and ⟪WUPAGE10⟫.";
    expect(normalizeProtectedText(source, "比较 ⟪WUPAGE10⟫ 与 ⟪WUPAGE1⟫。"))
      .toBe("比较 ⟪WUPAGE10⟫ 与 ⟪WUPAGE1⟫。");
    for (const value of ["⟪WUPAGE1⟫", "⟪WUPAGE1⟫ ⟪WUPAGE1⟫", "⟪WUPAGE1⟫ ⟪WUPAGE11⟫"]) {
      expect(normalizeProtectedText(source, value)).toBeUndefined();
    }
  });

  it("preserves the order and placement of line breaks, including a blank line", () => {
    const source = "First line. ⟪WUPAGEBREAK0⟫ ⟪WUPAGEBREAK1⟫ Second line.";
    expect(normalizeProtectedText(source, "第一行。\n《 WUPAGE BREAK 0 》《 WUPAGE BREAK 1 》第二行。"))
      .toBe("第一行。 ⟪WUPAGEBREAK0⟫⟪WUPAGEBREAK1⟫第二行。");
    for (const translation of [
      "第一行。第二行。",
      "第一行。⟪WUPAGEBREAK1⟫⟪WUPAGEBREAK0⟫第二行。",
      "第一行。⟪WUPAGEBREAK0⟫第二行。⟪WUPAGEBREAK1⟫"
    ]) expect(normalizeProtectedText(source, translation)).toBeUndefined();
  });
});

const request: TranslateBatchRequest = { texts: [], targetLang: "zh-CN", preservePlaceholders: true };

describe("protected text translation recovery", () => {
  it("restores a dropped line break using both source lines as context", async () => {
    const source = "From a ⟪WUPAGEBREAK0⟫ sketchboard";
    const translate = vi.fn(async (part: TranslateBatchRequest) => {
      if (part.texts.includes(source)) return ["来自一个草图板"];
      expect(part.texts).toEqual(["From a", "sketchboard"]);
      expect(part.context).toContain("From a \n sketchboard");
      return ["来自一个", "草图板"];
    });
    await expect(translateTextWithRecovery({ ...request, texts: [source] }, translate))
      .resolves.toEqual(["来自一个 ⟪WUPAGEBREAK0⟫ 草图板"]);
    expect(translate).toHaveBeenCalledTimes(3);
  });

  it("recovers missing, empty and incorrectly nested format scopes without losing their original structure", async () => {
    const source = "Read ⟪WUPAGEOPEN0⟫the ⟪WUPAGEOPEN1⟫complete⟪WUPAGECLOSE1⟫ guide⟪WUPAGECLOSE0⟫ now.";
    const translate = vi.fn(async (part: TranslateBatchRequest) => part.texts.map(text => text.includes("WUPAGE")
      ? "⟪WUPAGEOPEN0⟫⟪WUPAGEOPEN1⟫⟪WUPAGECLOSE1⟫⟪WUPAGECLOSE0⟫"
      : `译文：${text}`));
    const [result] = await translateTextWithRecovery({ ...request, texts: [source] }, translate);
    expect(normalizeProtectedText(source, result)).toBe(result);
    expect(result).toContain("⟪WUPAGEOPEN1⟫译文：complete⟪WUPAGECLOSE1⟫");
    expect(translate).toHaveBeenCalledTimes(3);
  });

  it("normalizes harmless typography changes without additional provider calls", async () => {
    const translate = vi.fn(async () => ["设 《 wupage 0 》 为常数。"]);
    await expect(translateTextWithRecovery({ ...request, texts: ["Let ⟪WUPAGE0⟫ be fixed."] }, translate))
      .resolves.toEqual(["设 ⟪WUPAGE0⟫ 为常数。"]);
    expect(translate).toHaveBeenCalledTimes(1);
  });

  it("retries only the paragraph with a missing marker", async () => {
    const translate = vi.fn()
      .mockResolvedValueOnce(["完好的 ⟪WUPAGE0⟫。", "标记丢失"])
      .mockResolvedValueOnce(["恢复的 ⟪WUPAGE1⟫。"]);
    await expect(translateTextWithRecovery({ ...request, texts: ["Good ⟪WUPAGE0⟫.", "Bad ⟪WUPAGE1⟫."] }, translate))
      .resolves.toEqual(["完好的 ⟪WUPAGE0⟫。", "恢复的 ⟪WUPAGE1⟫。"]);
    expect(translate).toHaveBeenCalledTimes(2);
    expect(translate.mock.calls[1][0].texts).toEqual(["Bad ⟪WUPAGE1⟫."]);
  });

  it("translates prose fragments and reinserts formulas locally when paragraph retry still drops them", async () => {
    const seen: TranslateBatchRequest[] = [];
    const translate = vi.fn(async (part: TranslateBatchRequest) => {
      seen.push(part);
      if (part.texts.some((text) => text.includes("WUPAGE"))) return ["模型持续遗漏标记"];
      expect(part.context).not.toContain("WUPAGE");
      expect(part.context).toContain("[protected content]");
      expect(part.texts).toEqual(["Let", "be fixed and", "be positive."]);
      return ["设", "为常数且", "为正数。"];
    });
    const source = "Let ⟪WUPAGE20⟫ be fixed and ⟪WUPAGE21⟫ be positive.";
    await expect(translateTextWithRecovery({ ...request, texts: [source], context: "Definition using ⟪WUPAGE20⟫" }, translate))
      .resolves.toEqual(["设 ⟪WUPAGE20⟫ 为常数且 ⟪WUPAGE21⟫ 为正数。"]);
    expect(seen).toHaveLength(3);
  });

  it("does not accept duplicate formulas and recovers malformed prose batches individually", async () => {
    const translate = vi.fn()
      .mockResolvedValueOnce(["⟪WUPAGE0⟫ ⟪WUPAGE0⟫"])
      .mockResolvedValueOnce(["⟪WUPAGE0⟫ ⟪WUPAGE0⟫"])
      .mockResolvedValueOnce(["条目数错误"])
      .mockResolvedValueOnce(["设"])
      .mockResolvedValueOnce(["大于"])
      .mockResolvedValueOnce(["成立。"]);
    const source = "Let ⟪WUPAGE0⟫ exceed ⟪WUPAGE1⟫ as required.";
    const [result] = await translateTextWithRecovery({ ...request, texts: [source] }, translate);
    expect(result).toBe("设 ⟪WUPAGE0⟫ 大于 ⟪WUPAGE1⟫ 成立。");
    expect(protectedTextTokens(result)).toEqual(protectedTextTokens(source));
    expect(translate).toHaveBeenCalledTimes(6);
  });

  it("caps fragment batch size even for paragraphs containing many formulas", async () => {
    const source = Array.from({ length: 35 }, (_, index) => `text ⟪WUPAGE${index}⟫ `).join("") + "end";
    const translate = vi.fn(async (part: TranslateBatchRequest) => part.texts.some((text) => text.includes("WUPAGE"))
      ? part.texts.map(() => "丢失标记")
      : part.texts.map(() => "译文"));
    const [result] = await translateTextWithRecovery({ ...request, texts: [source] }, translate);
    expect(protectedTextTokens(result)).toEqual(protectedTextTokens(source));
    expect(translate.mock.calls.slice(2).map(([part]) => part.texts.length)).toEqual([16, 16, 4]);
  });

  it("does not retry authentication or network failures as prose fragments", async () => {
    const translate = vi.fn().mockResolvedValueOnce(["丢失标记"]).mockRejectedValueOnce(new Error("LLM request failed: 403"));
    await expect(translateTextWithRecovery({ ...request, texts: ["Let ⟪WUPAGE0⟫ be fixed."] }, translate))
      .rejects.toThrow("403");
    expect(translate).toHaveBeenCalledTimes(2);
  });
});
