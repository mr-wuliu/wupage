import { describe, expect, it } from "vitest";
import { OPS } from "pdfjs-dist/legacy/build/pdf.mjs";
import { detectPdfMathStructure, readPdfPageGeometry } from "../src/pdf/math-structure";
import { extractTextBlocks, type PdfTextItemLike } from "../src/pdf/model";

const item = (str: string, x: number, y: number, size = 10, font = "OpaqueA", width = str.length * size * 0.5): PdfTextItemLike => ({
  str, transform: [size, 0, 0, size, x, y], height: size, width, fontFace: font, fontName: font
});

describe("font-independent PDF math evidence", () => {
  it("recognizes positioned scripts even when the content stream is out of order", () => {
    const base = item("x", 20, 100), script = item("if", 25, 97, 6), prose = item("if", 80, 100);
    const evidence = detectPdfMathStructure([script, prose, base]);
    expect([...evidence.math]).toEqual(expect.arrayContaining([base, script]));
    expect(evidence.math.has(prose)).toBe(false);
  });

  it("learns a custom symbol font from encoding and nearby expressions", () => {
    const items = [item("The objective is:", 10, 150, 10, "OpaqueB"),
      item("max", 10, 100, 10, "OpaqueB"), item("F", 30, 100), item("2", 35, 97, 6, "OpaqueB"),
      item("¼", 42, 100, 10, "OpaqueC"), item("Riv", 51, 100),
      item("ð", 180, 100, 10, "OpaqueC"), item("2", 185, 100, 10, "OpaqueB"), item("Þ", 190, 100, 10, "OpaqueC"),
      item("The explanation follows.", 10, 60, 10, "OpaqueB")];
    expect(extractTextBlocks(items, 1).filter(block => block.translatable).map(block => block.text)).toEqual([
      "The objective is:", "The explanation follows."
    ]);
  });

  it("recognizes a fraction from the painted rule without math font names or operators", () => {
    const numerator = item("ab", 20, 105), denominator = item("cd", 20, 91);
    const items = [item("A fraction follows.", 10, 150), numerator, denominator, item("Next paragraph.", 10, 60)];
    expect(detectPdfMathStructure(items).math.size).toBe(0);
    const rules = [{ x: 19, y: 100, width: 12, height: 0.4 }];
    const blocks = extractTextBlocks(items, 1, undefined, rules);
    expect(blocks.filter(block => block.translatable).map(block => block.text)).toEqual(["A fraction follows.", "Next paragraph."]);
  });

  it("does not classify underlines, table cells, dates or ordinary fractions as formulas", () => {
    const items = [item("Age", 20, 150), item("24", 20, 124), item("January 2025", 80, 150),
      item("Use", 20, 100), item("½", 40, 100), item("cup", 48, 100), item("of", 68, 100), item("flour", 83, 100),
      item("An underlined phrase", 20, 70)];
    const evidence = detectPdfMathStructure(items, [{ x: 19, y: 143, width: 50, height: 0.5 }, { x: 20, y: 68, width: 100, height: 0.5 }]);
    expect(evidence.math.size).toBe(0);
    expect(extractTextBlocks(items, 1).filter(block => block.translatable).map(block => block.text).join(" ")).toContain("Use ½ cup of flour".normalize("NFKC"));
  });

  it("protects reduced text inside an inline fraction without absorbing nearby prose", () => {
    const words = [item("The ratio is", 10, 100, 10, "OpaqueA", 50), item("1", 64, 100), item("−", 70, 100),
      item("squared deviations in groups", 78, 103, 6, "OpaqueA", 90), item("squared deviations in all cases", 82, 95, 6, "OpaqueA", 82),
      item("and explains the variance.", 172, 100)];
    // Include surrounding body lines to establish the document's normal size.
    words.unshift(item("This is the previous sentence.", 10, 120), item("Another explanation.", 10, 140));
    const blocks = extractTextBlocks(words, 1, undefined, [{ x: 78, y: 101, width: 90, height: 0.4 }]);
    const translatable = blocks.filter(block => block.translatable);
    expect(translatable.map(block => block.text).join(" ")).not.toContain("squared deviations");
    expect(translatable.map(block => block.text).join(" ")).toContain("and explains the variance");
    expect(translatable.flatMap(block => block.formulas?.map(f => f.text) ?? []).join(" ")).toContain("squared deviations in groups");
    const caption = words.filter(run => !["1", "−"].includes(run.str));
    expect(detectPdfMathStructure(caption, [{ x: 78, y: 101, width: 90, height: 0.4 }]).math.size).toBe(0);
  });

  it("does not spread font evidence to prose, small caps or a neighbouring column", () => {
    const items = [item("x", 20, 100), item("i", 25, 97, 6), item("=", 32, 100), item("y", 40, 100),
      item("new", 80, 100), item("and", 100, 100), item("important", 120, 100),
      item("M", 20, 60), item("ODEL", 25, 60, 8), item("age", 320, 100)];
    const evidence = detectPdfMathStructure(items);
    expect(items.filter(run => evidence.math.has(run)).map(run => run.str)).toEqual(["x", "i", "=", "y"]);
  });

  it("preserves merged identifiers learned from positioned subscripts on the same page", () => {
    const blocks = extractTextBlocks([
      item("A bound is defined here.", 10, 180), item("low", 20, 150, 10, "OpaqueA", 13), item("j", 33, 147, 7, "OpaqueA", 2),
      item("The bound", 10, 100, 10, "OpaqueA", 45), item("lowj", 60, 100, 10, "OpaqueA", 15),
      item("remains unchanged.", 80, 100)
    ], 1);
    const paragraph = blocks.find(block => block.text.startsWith("The bound"));
    expect(paragraph?.translatable).toBe(true);
    expect(paragraph?.formulas?.map(formula => formula.text)).toEqual(["lowj"]);
  });

  it("does not infer an identifier from spelling alone when its font or width differs", () => {
    const source = [item("Ordinary words must remain available for translation.", 10, 180),
      item("low", 20, 150, 10, "OpaqueA", 13), item("j", 33, 147, 7, "OpaqueA", 2),
      item("lowj", 20, 100, 10, "OpaqueB", 15), item("lowj", 100, 100, 10, "OpaqueA", 22)];
    const evidence = detectPdfMathStructure(source);
    expect(source.slice(-2).every(run => !evidence.math.has(run))).toBe(true);
  });

  it("preserves unreadable prose instead of sending corrupted text for translation", () => {
    const blocks = extractTextBlocks([item("Unreadable \ufffd text", 20, 100), item("Readable text remains translatable.", 20, 70)], 1);
    expect(blocks[0]).toMatchObject({ preserveOriginal: true, translatable: false });
    expect(blocks[1].translatable).toBe(true);
  });

  it("distinguishes severely expanded glyph mappings from ordinary ligatures", () => {
    const root = item("ffi".repeat(45), 20, 100, 10, "OpaqueC", 100);
    const prose = item("efficient office filing", 20, 70, 10, "OpaqueD", 95);
    const evidence = detectPdfMathStructure([root, prose]);
    expect(evidence.extensions.has(root)).toBe(true);
    expect(evidence.unreadable.has(prose)).toBe(false);
    expect(evidence.math.has(prose)).toBe(false);
  });

  it("does not learn a shared font role when font identity is missing", () => {
    const equation = item("x=y", 20, 100, 10, ""), label = item("Age", 200, 100, 10, "");
    expect(detectPdfMathStructure([equation, label]).math.has(label)).toBe(false);
  });

  it("does not extend a local equation into short labels elsewhere in the same font", () => {
    const equation = item("x=y", 20, 100), label = item("Age", 200, 100);
    expect(detectPdfMathStructure([equation, label]).math.has(label)).toBe(false);
  });

  it("keeps hyphenated word tails and separate italic ligatures in prose", () => {
    const blocks = extractTextBlocks([
      item("We introduce a vec-", 20, 130), item("tor", 20, 116), item("S", 38, 116, 10, "CMMI10"),
      item("=", 46, 116), item("x", 54, 116, 10, "CMMI10"),
      item("Arti", 20, 80, 10, "OpaqueA", 18), item("fi", 38, 80, 10, "Opaque.I+fb", 5),
      item("cial Intelligence", 43, 80, 10, "OpaqueA")
    ], 1);
    const text = blocks.filter(block => block.translatable).map(block => block.text).join(" ");
    expect(text).toContain("vector");
    expect(text).toContain("Artificial Intelligence");
    expect(blocks.flatMap(block => block.formulas?.map(f => f.text) ?? [])).toEqual(["S=x"]);
  });

  it("handles malformed coordinates and huge advances without scanning empty space", () => {
    const items = [item("x", 0, 100, 10, "OpaqueA", 1e12), item("y", Number.NaN, 100), item("Normal paragraph.", 0, 60)];
    expect(detectPdfMathStructure(items).math.size).toBe(0);
  });
});

describe("piecewise PDF expressions", () => {
  const twoCases = (): PdfTextItemLike[] => [
    item("The following expression applies.", 10, 135),
    item("x", 20, 90), item("=", 28, 90),
    item("0", 50, 97), item("if", 100, 97), item("x<0", 115, 97),
    item("1", 50, 82), item("if", 100, 82), item("x>1", 115, 82),
    { ...item("(", 40, 106, 10, "OpaqueDelimiter", 8), fontAscent: 0, fontDescent: 0 },
    item("(19)", 200, 90), item("The next paragraph explains the bounds.", 10, 55)
  ];

  it("preserves condition text and merged variables inside a misdecoded brace", () => {
    const blocks = extractTextBlocks(twoCases(), 1);
    expect(blocks.filter(block => block.translatable).map(block => block.text)).toEqual([
      "The following expression applies.", "The next paragraph explains the bounds."
    ]);
    expect(blocks.filter(block => block.preserveOriginal).map(block => block.text).join("")).toContain("0ifx<01ifx>1");
  });

  it("protects arbitrary function names and fallback words across a stacked delimiter", () => {
    const parts = [item("x", 20, 91), item("=", 28, 91),
      item("sample", 50, 106, 10, "OpaqueA", 28), item("ðxÞ", 78, 106, 10, "OpaqueB", 14),
      item("when", 110, 106), item("x<0", 135, 106),
      item("sample", 50, 91, 10, "OpaqueA", 28), item("ðyÞ", 78, 91, 10, "OpaqueB", 14),
      item("when", 110, 91), item("x>1", 135, 91), item("xij", 50, 76, 10, "OpaqueB", 8), item("otherwise", 110, 76),
      ...[["8", 113], [">", 105], ["<", 102], [">", 86], [":", 83]].map(([text, y]) => item(String(text), 40, Number(y), 10, "OpaqueDelimiter", 8))];
    const blocks = extractTextBlocks([item("Before the expression.", 10, 140), ...parts, item("After the expression.", 10, 50)], 1);
    expect(blocks.filter(block => block.translatable).map(block => block.text)).toEqual(["Before the expression.", "After the expression."]);
    const reversed = detectPdfMathStructure([...parts].reverse());
    expect(parts.every(part => reversed.display.has(part))).toBe(true);
  });

  it("keeps ordinary conditional prose and a nearby column outside the display", () => {
    const source: PdfTextItemLike[] = twoCases().map(run => ({ ...run, transform: [...Array.from(run.transform).slice(0, 4), Number(run.transform[4]) + 300, Number(run.transform[5])] }));
    source.unshift(item("If the model converges, report the result.", 10, 90, 10, "OpaqueA", 190));
    const blocks = extractTextBlocks(source, 1);
    expect(blocks.find(block => block.text.startsWith("If the model"))?.translatable).toBe(true);
    expect(blocks.some(block => block.preserveOriginal && block.text.includes("0ifx<0"))).toBe(true);
    expect(blocks.filter(block => block.translatable).every(block => !block.formulas?.some(formula => formula.text.includes("0ifx<0")))).toBe(true);
  });

  it("does not turn aligned table labels into a cases expression without a left relation", () => {
    const source = twoCases().filter(run => !["x", "="].includes(run.str));
    const result = detectPdfMathStructure(source);
    expect(result.display.size).toBe(0);
    expect(source.filter(run => run.str === "if").every(run => !result.math.has(run))).toBe(true);
  });

  it("does not absorb full sentences following a delimiter", () => {
    const source = twoCases().map(run => run.str === "if" ? { ...run, str: "if the boundary is exceeded then correct it", width: 180 } : run);
    expect(detectPdfMathStructure(source).display.size).toBe(0);
  });
});

describe("painted PDF fraction rules", () => {
  const path = (box: number[], paint: number = OPS.fill) => [paint, [], new Float32Array(box)];
  const viewport = { height: 800, transform: [2, 0, 0, -2, -100, 900] };

  it("uses the same crop, unit and saved form transforms as text extraction", () => {
    const { rules } = readPdfPageGeometry({
      fnArray: [OPS.save, OPS.transform, OPS.paintFormXObjectBegin, OPS.constructPath, OPS.paintFormXObjectEnd, OPS.restore, OPS.constructPath],
      argsArray: [[], [1, 0, 0, 1, 10, 20], [[1, 0, 0, 1, 5, 10]], path([100, 200, 120, 200.5]), [], [], path([100, 200, 120, 200.5])]
    }, OPS, viewport);
    expect(rules).toEqual([{ x: 130, y: 360, width: 40, height: 1 }, { x: 100, y: 300, width: 40, height: 1 }]);
  });

  it("rejects vertical, thick, invisible and non-painted paths", () => {
    const { rules } = readPdfPageGeometry({
      fnArray: [OPS.constructPath, OPS.constructPath, OPS.constructPath, OPS.setGState, OPS.constructPath, OPS.beginMarkedContentProps, OPS.constructPath, OPS.endMarkedContent],
      argsArray: [path([10, 10, 10.5, 30]), path([10, 10, 30, 15]), path([10, 10, 30, 10.5], OPS.clip), [[['ca', 0]]],
        path([10, 10, 30, 10.5]), ['OC', {}], path([10, 10, 30, 10.5], OPS.stroke), []]
    }, OPS, viewport, { isVisible: () => false });
    expect(rules).toEqual([]);
  });

  it("includes stroked rules at the displayed rotation", () => {
    const { rules } = readPdfPageGeometry({ fnArray: [OPS.setLineWidth, OPS.constructPath], argsArray: [[0.4], path([10, 20, 10, 40], OPS.stroke)] },
      OPS, { height: 600, transform: [0, 1, 1, 0, 0, 0] });
    expect(rules).toEqual([{ x: 20, y: 590, width: 20, height: 0.4 }]);
  });

  it("extracts transformed rectangular fills as cell boundaries", () => {
    const rectangle = [OPS.fill, [new Float32Array([0, 100, 200, 1, 120, 200, 1, 120, 210, 1, 100, 210, 4])],
      new Float32Array([100, 200, 120, 210])];
    const triangle = [OPS.fill, [new Float32Array([0, 100, 200, 1, 120, 200, 1, 120, 210, 4])],
      new Float32Array([100, 200, 120, 210])];
    const geometry = readPdfPageGeometry({
      fnArray: [OPS.transform, OPS.constructPath, OPS.constructPath],
      argsArray: [[1, 0, 0, 1, 10, 15], rectangle, triangle]
    }, OPS, viewport);
    expect(geometry).toEqual({ rules: [], cells: [{ x: 120, y: 330, width: 40, height: 20 }], tableCells: [] });
  });
});

describe("PDF table rule cells", () => {
  it("preserves wrapped conditions within their cells and leaves adjacent labels translatable", () => {
    const source = [
      item("Rules and thresholds", 125, 150, 8),
      item("Selected grouping (three classes)", 10, 132, 8, "OpaqueA", 106),
      item("(obtained by the method)", 10, 122, 8, "OpaqueA", 89),
      item("1. LOS ≤ 10 and", 125, 132, 8, "OpaqueA", 58),
      item("Age > 17", 125, 122, 8, "OpaqueA", 35),
      item("403", 230, 132, 8),
      item("2. LOS", 125, 107, 8, "OpaqueA", 21), item("≤", 148, 107, 8, "OpaqueB", 4),
      item("10 and Age ≤ 17", 153, 107, 8, "OpaqueA", 55), item("655", 230, 107, 8),
      item("3. LOS > 10", 125, 87, 8, "OpaqueA", 40), item("468", 230, 87, 8)
    ];
    const ruleCells = [{ x: 120, y: 116, width: 105, height: 25 }, { x: 120, y: 96, width: 105, height: 20 },
      { x: 120, y: 76, width: 105, height: 20 }];
    const countCells = ruleCells.map(cell => ({ ...cell, x: 225, width: 30 }));
    const cells = [...ruleCells, ...countCells];
    const blocks = extractTextBlocks(source, 1, undefined, [], cells);
    expect(blocks.filter(block => block.preserveOriginal && /\p{L}/u.test(block.text)).map(block => block.text)).toEqual([
      "1. LOS ≤ 10 and", "Age > 17", "2. LOS ≤ 10 and Age ≤ 17", "3. LOS > 10"
    ]);
    expect(blocks.find(block => block.text === "1. LOS ≤ 10 and")?.lines[0]).toMatchObject({ x: 125, sourceBounds: ruleCells[0] });
    expect(blocks.filter(block => block.translatable).map(block => block.text).join(" ")).toContain("obtained by the method)");
    expect(blocks.find(block => block.text === "Rules and thresholds")?.translatable).toBe(true);
    expect(blocks.filter(block => /^(?:403|655|468)$/u.test(block.text)).map(block => block.lines[0].sourceBounds)).toEqual(countCells);
    expect(blocks.every(block => !block.formulas?.length)).toBe(true);
  });
});
