import { describe, expect, it } from "vitest";
import { extractTextBlocks, type PdfTextItemLike } from "../src/pdf/model";
import { protectPdfMath, validatePdfMathTranslation } from "../src/pdf/math";

function item(str: string, x: number, y: number, size = 11, fontName = "CMR10", width = str.length * 5): PdfTextItemLike {
  return { str, transform: [1, 0, 0, size, x, y], width, height: size, fontName, fontFamily: "serif" };
}

describe("PDF formula preservation", () => {
  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])("uses finite bounds when font metrics are %s", metric => {
    const result = protectPdfMath([
      { ...item("x = y", 20, 100, 10, "CMMI10"), fontAscent: metric, fontDescent: metric },
      { ...item("The next paragraph.", 20, 70), fontAscent: metric }
    ]);
    expect(result.formulas).toHaveLength(1);
    expect(Object.values(result.formulas[0]).filter(value => typeof value === "number").every(Number.isFinite)).toBe(true);
  });

  it("keeps multiplication dots and nested named functions in one inline formula", () => {
    const result = protectPdfMath([
      item("The embedding is", 10, 100, 10, "Times-Roman", 70),
      item("W3", 82, 100, 10, "CMMI10", 12), item("·", 96, 100, 10, "CMSY10", 3),
      item("swish", 102, 100, 10, "Times-Roman", 23), item("(", 125, 100, 10, "CMR10", 4),
      item("W2", 129, 100, 10, "CMMI10", 12), item("·", 143, 100, 10, "CMSY10", 3),
      item("concat", 149, 100, 10, "Times-Roman", 26), item("(", 175, 100, 10, "CMR10", 4),
      item("W1", 179, 100, 10, "CMMI10", 12), item("·", 193, 100, 10, "CMSY10", 3),
      item("a", 199, 100, 10, "CMMI10", 6), item(")))", 205, 100, 10, "CMR10", 12),
      item(", where", 219, 100, 10, "Times-Roman", 30)
    ]);
    expect(result.formulas.map(formula => ({ text: formula.text, display: formula.display }))).toEqual([
      { text: "W3·swish(W2·concat(W1·a)))", display: false }
    ]);
  });

  it("keeps a line-leading multiplication dot attached to a wrapped math continuation", () => {
    const result = protectPdfMath([
      item("The result is", 10, 100, 10, "Times-Roman", 55), item("x", 100, 100, 10, "CMMI10", 6),
      item("·", 10, 85, 10, "CMSY10", 3), item("y", 16, 85, 10, "CMMI10", 6),
      item("in this model.", 25, 85, 10, "Times-Roman", 60)
    ]);
    expect(result.formulas.at(-1)).toMatchObject({ text: "·y", display: false });
  });

  it("preserves genuine middle-dot list markers before prose", () => {
    const blocks = extractTextBlocks([
      item("·", 20, 100, 10, "CMSY10", 4), item("First list item", 30, 100, 10, "Times-Roman", 70),
      item("·", 20, 85, 10, "CMSY10", 4), item("Second list item", 30, 85, 10, "Times-Roman", 75)
    ], 5);
    expect(blocks.map(block => block.text)).toEqual(["· First list item", "· Second list item"]);
    expect(blocks.every(block => block.translatable && !block.formulas?.length)).toBe(true);
  });

  it("leaves unmatched prose parentheses outside formulas while retaining function arguments", () => {
    const result = protectPdfMath([
      item("Assume", 10, 100), item("f", 50, 100, 10, "CMMI10"), item("(", 55, 100, 10, "CMSS10"),
      item("this is a condition", 60, 100, 10, "CMSS10"),
      item("g", 150, 100, 10, "CMMI10"), item("(x)", 155, 100, 10, "CMR10"),
      item(")", 170, 100, 10, "CMSS10"), item("is positive", 180, 100)
    ]);
    expect(result.formulas.map((formula) => formula.text)).toEqual(["f", "g(x)"]);
    expect(result.items.filter((item) => item.str.trim() === "(" || item.str.trim() === ")")).toHaveLength(2);
  });
  it("uses actual inline glyph bounds instead of CMSY's font-wide descent", () => {
    const result = protectPdfMath([
      item("when", 10, 100),
      { ...item("→", 40, 100, 10, "CMSY10"), fontAscent: 0.775, fontDescent: -0.96 },
      item("converges", 55, 100)
    ], (_item, text) => ({ width: text.length * 5, actualBoundingBoxAscent: 5, actualBoundingBoxDescent: 0 }));
    expect(result.formulas[0].display).toBe(false);
    expect(result.formulas[0].height).toBeCloseTo(6.6);
    expect(result.formulas[0].y).toBeCloseTo(99.2);
  });

  it("keeps math-font bullets as structural markers so list items remain separate", () => {
    const blocks = extractTextBlocks([
      item("•", 20, 100, 10, "CMSY10", 4), item("First list item", 30, 100, 10, "CMSS10", 70),
      item("•", 20, 85, 10, "CMSY10", 4), item("Second list item", 30, 85, 10, "CMSS10", 75)
    ], 5);
    expect(blocks.map((block) => block.text)).toEqual(["• First list item", "• Second list item"]);
    expect(blocks.every((block) => block.translatable && !block.formulas?.length)).toBe(true);
  });
  it("keeps a tall closing delimiter drawn last inside the same display crop", () => {
    const blocks = extractTextBlocks([
      item("x =", 30, 675, 10, "CMMI10", 30),
      item("y", 100, 675, 10, "CMMI10", 10),
      item("z", 100, 653.56, 10, "CMMI10", 10),
      item("!", 112, 681.67, 10, "TeX_CM_Maths_Extension", 8)
    ], 1);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ preserveOriginal: true, translatable: false });
    expect(blocks[0].text).toContain("!");
    expect(blocks[0].lines[0].baselineY - blocks[0].lines[0].height * 0.24).toBeLessThan(650);
  });

  it("preserves named functions in Transformer equations without classifying ordinary discussion as math", () => {
    const blocks = extractTextBlocks([
      item("Attention", 30, 100, 11, "Times-Roman", 45),
      item("(Q, K, V ) =", 75, 100, 11, "CMMI10", 60),
      item("softmax", 140, 100, 11, "Times-Roman", 30),
      item("(QK)", 170, 100, 11, "CMMI10", 30),
      item("Attention improves performance.", 20, 60)
    ], 1);
    expect(blocks[0]).toMatchObject({ preserveOriginal: true, translatable: false });
    expect(blocks[0].text).toContain("Attention");
    expect(blocks[1]).toMatchObject({ text: "Attention improves performance.", translatable: true });
  });

  it("does not mistake another formula token for prose or strip an encoded brace glyph as punctuation", () => {
    const blocks = extractTextBlocks([
      item("x", 100, 190, 10, "CMMI10"), item("= 0", 110, 190),
      item("8", 80, 210, 10, "TeX_CM_Maths_Extension", 9),
      item(">", 80, 200, 10, "TeX_CM_Maths_Extension", 9),
      item(":", 80, 190, 10, "TeX_CM_Maths_Extension", 9)
    ], 1);
    expect(blocks.every((block) => block.preserveOriginal && !block.translatable)).toBe(true);
    const brace = blocks.find((block) => block.text.includes("8"))!;
    expect(brace.text).toContain(":");
    expect(brace.lines[0].width).toBeGreaterThanOrEqual(9);
  });

  it("keeps upright TeX variables in PLOS equations, including products that resemble short words", () => {
    const blocks = extractTextBlocks([
      item("The differential equation is", 20, 160),
      item("dR", 50, 100, 10, "TeX_CM_Maths_Italic"),
      item("dt", 50, 90, 10, "TeX_CM_Roman"),
      item("=", 70, 95, 10, "TeX_CM_Roman"),
      item("co", 85, 95, 10, "PI_chars_2"),
      item("SI", 100, 95, 10, "LVCSCJ+MinionPro-It"),
      item("The following discussion is ordinary prose.", 20, 50)
    ], 1);
    expect(blocks.filter((block) => block.translatable).map((block) => block.text)).toEqual([
      "The differential equation is", "The following discussion is ordinary prose."
    ]);
    expect(blocks.find((block) => block.preserveOriginal)?.text).toContain("coSI");
  });

  it("keeps distance and domain operators inside the preserved equation", () => {
    const blocks = extractTextBlocks([
      item("dist", 30, 100), item("(x, dom", 50, 100, 11, "CMR10"),
      item("f", 85, 100, 11, "CMMI10"), item(") ≥ 0", 95, 100)
    ], 1);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ preserveOriginal: true, translatable: false });
  });

  it("keeps sentence punctuation outside inline images while retaining commas inside interval notation", () => {
    const blocks = extractTextBlocks([
      item("For any function", 73, 269, 11, "CMR10", 83),
      item("f", 161, 269, 11, "CMMI10", 6),
      item(": R → [", 167, 269, 11, "CMSY10", 45),
      item("−∞,+∞", 212, 269, 11, "CMSY10", 40),
      item("], the conjugate is defined below.", 252, 269)
    ], 3, (_item, text) => text.length * 5);
    expect(blocks[0].formulas?.[0].text).toBe("f: R → [−∞,+∞]");
    expect(blocks[0].text).toBe("For any function ⟪WUPAGE0⟫, the conjugate is defined below.");
    expect(blocks[0].formulas![0].x + blocks[0].formulas![0].width).toBeCloseTo(257);
  });

  it("does not turn an isolated math-font punctuation mark into an empty formula", () => {
    const result = protectPdfMath([item("A sentence", 20, 100), item(",", 75, 100, 11, "CMMI10"), item("then the next clause", 85, 100)]);
    expect(result.formulas).toEqual([]);
    expect(result.items.map((item) => item.str).join("")).toContain(",");
  });

  it("crops the two lines of a wrapped inline definition separately without capturing prose between them", () => {
    const blocks = extractTextBlocks([
      item("For any function, its conjugate is defined by", 73, 269, 11, "CMR10", 405),
      item("f", 483, 269, 11, "CMMI10", 5),
      item("∗", 489, 273, 8, "CMSY8", 4),
      { ...item("(x) :=", 494, 269, 11, "CMR10", 33), hasEOL: true },
      item("sup", 73, 255, 11, "CMR10", 17),
      item("y", 90, 252, 8, "CMMI8", 5),
      item("∈", 95, 252, 8, "CMSY8", 6),
      item("R", 101, 252, 8, "MSBM10", 6),
      item("n", 107, 254, 6, "CMMI6", 4),
      item("{〈y,x〉−f(y)}", 112, 255, 11, "CMMI10", 71),
      item(", the proximal mapping and Moreau envelope", 184, 255, 11, "CMR10", 340),
      item("are defined below.", 73, 241, 11, "CMR10", 100)
    ], 3);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].text).toBe("For any function, its conjugate is defined by ⟪WUPAGE0⟫ ⟪WUPAGE1⟫, the proximal mapping and Moreau envelope are defined below.");
    expect(blocks[0].formulas).toHaveLength(2);
    expect(blocks[0].formulas?.every((formula) => formula.width < 120 && formula.height < 20)).toBe(true);
  });

  it("keeps Prox and argmin inside a displayed equation instead of translating and resizing its pieces", () => {
    const blocks = extractTextBlocks([
      { ...item("The proximal mapping is defined as", 73, 242), hasEOL: true },
      item("Prox", 166, 215, 11, "CMR10", 23),
      item("f", 189, 213, 8, "CMMI8", 4),
      item("(x) :=", 195, 215, 11, "CMR10", 35),
      item("argmin", 241, 215, 11, "CMR10", 33),
      item("y", 247, 206, 8, "CMMI8", 4),
      item("∈", 251, 206, 8, "CMSY8", 6),
      item("R", 257, 206, 8, "MSBM10", 6),
      item("n", 263, 208, 6, "CMMI6", 4),
      item("{f(y)+", 276, 215, 11, "CMMI10", 41),
      item("1", 318, 223, 11, "CMR10", 6),
      item("2", 318, 208, 11, "CMR10", 6),
      item("‖y−x‖}", 326, 215, 11, "CMSY10", 49),
      item("Let a parameter be given.", 73, 176)
    ], 3);
    const equations = blocks.filter((block) => block.preserveOriginal);
    expect(equations).toHaveLength(1);
    expect(equations[0].text).toContain("Proxf(x) :=argmin");
    expect(blocks.filter((block) => block.translatable).map((block) => block.text)).toEqual([
      "The proximal mapping is defined as", "Let a parameter be given."
    ]);
  });

  it("keeps a slightly overhanging accented formula within its definition paragraph", () => {
    const blocks = extractTextBlocks([
      item("The regular subdifferential is written", 73, 130, 11, "CMR10", 363.5),
      item("ˆ", 435.1, 133, 11, "CMR10", 5),
      item("∂", 435.4, 130, 11, "CMMI10", 6),
      item("f(x)", 441.4, 130, 11, "CMMI10", 23),
      item(", is defined as", 465, 130, 11, "CMR10", 61)
    ], 3);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].text).toBe("The regular subdifferential is written ⟪WUPAGE0⟫, is defined as");
    expect(blocks[0].formulas?.[0].text).toBe("ˆ∂f(x)");
  });

  it("moves trailing accents and operator words out of prose before cropping the formula", () => {
    const { items, formulas } = protectPdfMath([
      item("Let ˜", 20, 100, 11, "CMR10", 25),
      item("x", 40, 100, 11, "CMMI10", 6),
      item("be a point, then lim", 50, 100, 11, "CMR10", 100),
      item("ρ", 150, 97, 8, "CMMI8", 6),
      item("↓0", 156, 97, 8, "CMSY8", 10),
      item("equals zero.", 170, 100)
    ], (_item, text) => text.length * 5);
    expect(formulas[0].text).toBe(" ˜x");
    expect(formulas[1].text).toBe(" limρ↓0");
    expect(items.filter((item) => !item.str.includes("WUPAGE")).map((item) => item.str).join(""))
      .not.toMatch(/[˜]|lim/);
  });

  it("preserves a displayed objective with fractions, scripts, braces and its equation number", () => {
    const blocks = extractTextBlocks([
      { ...item("Regularized quantile regression.", 73, 540), hasEOL: true },
      item("min", 203, 500),
      item("x", 200, 493, 8, "CMMI8"),
      item("∈", 205, 493, 8, "CMSY8"),
      item("R", 211, 493, 8, "MSBM10"),
      item("m", 217, 496, 6, "CMMI6"),
      item("{", 226, 516, 11, "CMEX10"),
      item("1", 235, 508),
      item("n", 235, 493, 11, "CMMI10"),
      item("∑", 243, 512, 11, "CMEX10"),
      item("i=1", 259, 494, 8, "CMMI8"),
      item("ρ", 273, 500, 11, "CMMI10"),
      item("}", 375, 516, 11, "CMEX10"),
      item("(2)", 513, 500),
      item("where the loss function is defined below.", 73, 462)
    ], 2);
    const equation = blocks.find((block) => block.preserveOriginal)!;
    expect(equation.translatable).toBe(false);
    expect(equation.text).toContain("minx∈Rm");
    expect(equation.text).toContain("(2)");
    expect(equation.lines[0].x).toBeLessThan(200);
    expect(equation.lines[0].width).toBeGreaterThan(320);
    expect(equation.lines[0].height).toBeGreaterThan(25);
    expect(blocks.filter((block) => block.translatable)).toHaveLength(2);
  });

  it("replaces inline math with one movable token, including numerals attached to the following prose", () => {
    const blocks = extractTextBlocks([
      item("where", 73, 453.6, 11, "CMR10", 28),
      item("ρ", 105, 453.6, 11, "CMMI10"),
      item("τ", 111, 451.9, 8, "CMMI8"),
      item("(μ <", 117, 453.6, 11, "CMMI10", 22),
      item("0)) is the loss function.", 143, 453.6)
    ], 2, (_item, text) => text.length * 5);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].text).toBe("where ⟪WUPAGE0⟫ is the loss function.");
    expect(blocks[0].formulas).toHaveLength(1);
    const formula = blocks[0].formulas![0];
    expect(formula.text).toBe("ρτ(μ <0)) ");
    expect(formula.display).toBe(false);
    expect(formula.x + formula.width).toBeLessThan(170);
  });

  it("keeps ordinary italic prose, dates and table values translatable as before", () => {
    const result = protectPdfMath([
      item("An italic discussion of the algorithm.", 73, 500, 11, "CMTI10"),
      item("2026 / 07", 73, 470),
      item("45", 300, 450),
      item("Deg.", 400, 450)
    ]);
    expect(result.formulas).toEqual([]);
  });

  it("does not translate isolated formulas even if they share a baseline with distant prose", () => {
    const blocks = extractTextBlocks([item("Description", 20, 100), item("α", 300, 100, 11, "CMMI10")], 1);
    const formula = blocks.find((block) => block.preserveOriginal)!;
    expect(formula.text).toBe("α");
    expect(formula.translatable).toBe(false);
  });

  it("accepts reordered math tokens but rejects omissions, duplication and unexpected formulas", () => {
    const { formulas } = protectPdfMath([
      item("where", 20, 100), item("α", 55, 100, 11, "CMMI10"),
      item("and", 70, 100), item("β", 95, 100, 11, "CMMI10"), item("are parameters.", 110, 100)
    ]);
    expect(() => validatePdfMathTranslation("参数 ⟪WUPAGE1⟫ 与 ⟪WUPAGE0⟫", formulas)).not.toThrow();
    for (const text of ["仅剩 ⟪WUPAGE0⟫", "⟪WUPAGE0⟫ ⟪WUPAGE0⟫", "⟪WUPAGE0⟫ ⟪WUPAGE1⟫ ⟪WUPAGE2⟫"]) {
      expect(() => validatePdfMathTranslation(text, formulas)).toThrow("未完整保留数学公式");
    }
  });
});
