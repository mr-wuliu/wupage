import { readFile } from "node:fs/promises";
import fontkit from "@pdf-lib/fontkit";
import { describe, expect, it } from "vitest";
import { PDFDocument, StandardFonts, PDFName, PDFRawStream, PDFDict, decodePDFRawStream } from "pdf-lib";
import { removePdfText } from "../src/pdf/content-stream";
import { buildSearchablePdf } from "../src/pdf/vector-export";

// fontkit reads OpenType containers rather than standalone PDF CFF streams.
// Reuse the fixture's container, pointing only its CFF record at the exported
// outlines. No checksums or metrics are needed to inspect paths by glyph ID.
function fontWithCff(container: Uint8Array, cff: Uint8Array) {
  const bytes = new Uint8Array(container.length + cff.length);
  bytes.set(container);
  bytes.set(cff, container.length);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < view.getUint16(4); i++) {
    const offset = 12 + i * 16;
    if (new TextDecoder().decode(bytes.subarray(offset, offset + 4)) !== "CFF ") continue;
    view.setUint32(offset + 8, container.length);
    view.setUint32(offset + 12, cff.length);
    return fontkit.create(bytes);
  }
  throw new Error("Missing CFF table in the test font");
}

describe("searchable PDF export", () => {
  it.each(["译文", ""])("uses the raster preview for missing characters, retaining supported text: %s", async supportedText => {
    const source = await PDFDocument.create(); source.addPage([400,500]);
    const png = new Uint8Array(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64"));
    const fontBytes = new Uint8Array(await readFile("tests/fixtures/pdf-export-font.otf"));
    expect(fontkit.create(fontBytes).hasGlyphForCodePoint("。".codePointAt(0)!)).toBe(false);
    let fallback: number[] = [];
    const bytes = await buildSearchablePdf([{width:400,height:500,imageBytes:png,format:"png",scene:{
      unchanged:false,transform:[1,0,0,-1,0,500],images:[],text:[
        {text:supportedText,x:30,y:80,width:24,size:12,color:[0,0,0]},
        {text:"。",x:54,y:80,width:12,size:12,color:[0,0,0]}
      ]
    }}],"Font fallback",await source.save(),fontBytes,pages=>{fallback=pages;});
    expect(fallback).toEqual([1]);
    const exported=await PDFDocument.load(bytes);
    const streams=exported.context.enumerateIndirectObjects().flatMap(([,object])=>object instanceof PDFRawStream
      ?[new TextDecoder().decode(decodePDFRawStream(object).decode())]:[]);
    if(supportedText)expect(streams.some(text=>text.includes("3 Tr"))).toBe(true);
    expect(streams.some(text=>text.includes("0 Tr"))).toBe(false);
    const {getDocument}=await import("pdfjs-dist/legacy/build/pdf.mjs"),loading=getDocument({data:bytes.slice()}),pdf=await loading.promise;
    const text=(await(await pdf.getPage(1)).getTextContent()).items.flatMap(item=>"str"in item?[item.str]:[]).join("");
    expect(text).toBe(supportedText);
    await loading.destroy();
  });

  it.each([
    "1) 中文译文 ABCDEFGHIJKLMNOPQRSTUVWXYZ abcdefghijklmnopqrstuvwxyz 0123456789 日本語 한국어 Русский Ελληνικα 繁體𠮷",
    "中文 A 测试 B 日本語 K 한국어 L Русский M Ελληνικα N 繁體 Z 𠮷",
  ])("preserves actual glyph outlines across mixed font dictionaries: %s", async (text) => {
    const fontBytes = new Uint8Array(await readFile("tests/fixtures/pdf-export-font.otf"));
    const original = fontkit.create(fontBytes);
    const source = await PDFDocument.create();
    source.addPage([800, 200]);
    const bytes = await buildSearchablePdf([{ width: 800, height: 200, imageBytes: new Uint8Array(), format: "png", scene: {
      unchanged: false, transform: [1, 0, 0, -1, 0, 200], images: [],
      text: [{ text, x: 10, y: 50, width: 780, size: 12, color: [0, 0, 0] }]
    } }], "Mixed glyphs", await source.save(), fontBytes);
    const exported = await PDFDocument.load(bytes);
    const streams = exported.context.enumerateIndirectObjects().flatMap(([, object]) => object instanceof PDFRawStream ? [object] : []);
    const cff = streams.find((stream) => stream.dict.get(PDFName.of("Subtype")) === PDFName.of("CIDFontType0C"))!;
    const embedded = fontWithCff(fontBytes, decodePDFRawStream(cff).decode());
    const cmap = streams.map((stream) => new TextDecoder().decode(decodePDFRawStream(stream).decode()))
      .find((contents) => contents.includes("beginbfchar"))!;
    let compared = 0;
    for (const section of cmap.matchAll(/beginbfchar([\s\S]*?)endbfchar/gu)) {
      for (const match of section[1].matchAll(/<([\dA-F]+)>\s*<([\dA-F]+)>/giu)) {
        const cid = parseInt(match[1], 16);
        const unicode = String.fromCharCode(...match[2].match(/.{4}/gu)!.map((unit) => parseInt(unit, 16)));
        const glyphs = original.layout(unicode).glyphs;
        expect(glyphs).toHaveLength(1);
        expect(embedded.getGlyph(cid).path.toSVG(), `outline for ${unicode}`).toBe(glyphs[0].path.toSVG());
        compared++;
      }
    }
    expect(compared).toBeGreaterThan(20);
  });

  it("removes text operands without interpreting operators inside strings, arrays or comments", () => {
    const source = String.raw`q 1 0 0 1 10 20 cm BT /F1 10 Tf (text Tj \(parentheses\)) Tj [<0031> 20 (BT ET)] TJ 1 2 (next) " (line) ' ET
% (comment Tj)
0 0 m 30 40 l S Q`;
    const clean = new TextDecoder().decode(removePdfText(new TextEncoder().encode(source)));
    expect(clean).not.toContain("parentheses");
    expect(clean).not.toContain("0031");
    expect(clean).not.toContain("/F1");
    expect(clean).toContain("0 0 m 30 40 l S");
    expect(clean).toContain("% (comment Tj)");
    expect(removePdfText(new TextEncoder().encode("BI /W 1 /H 1 ID opaque EI"))).toBeUndefined();
    expect(removePdfText(new TextEncoder().encode("BT 7 Tr (mask) Tj ET"))).toBeUndefined();
  });

  it("embeds Unicode text and retains vector graphics while removing the replaced source text", async () => {
    const source = await PDFDocument.create(), page = source.addPage([400, 500]);
    const latin = await source.embedFont(StandardFonts.Helvetica);
    page.drawText("Original words must be removed.", { x: 30, y: 420, size: 12, font: latin });
    page.drawLine({ start: { x: 20, y: 100 }, end: { x: 300, y: 150 }, thickness: 2 });
    const png = new Uint8Array(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64"));
    const fontBytes = new Uint8Array(await readFile("tests/fixtures/pdf-export-font.otf"));
    const bytes = await buildSearchablePdf([{ width: 400, height: 500, imageBytes: png, format: "png", scene: {
      unchanged: false, transform: [1, 0, 0, -1, 0, 500], images: [], text: [{ text: "中文译文 繁體𠮷 日本語 한국어 Русский Ελληνικα", x: 30, y: 80, size: 12, width: 250, color: [0, 0, 0] }]
    } }], "Searchable translation", await source.save(), fontBytes);
    expect(bytes.byteLength).toBeLessThan(100_000);
    const exported = await PDFDocument.load(bytes);
    expect(exported.getPageCount()).toBe(1);
    const streams = exported.context.enumerateIndirectObjects().flatMap(([, object]) => object instanceof PDFRawStream
      ? [new TextDecoder().decode(decodePDFRawStream(object).decode())] : []);
    expect(streams.some((text) => text.includes("beginbfchar"))).toBe(true);
    expect(streams.some((text) => text.includes(" m\n") && text.includes(" l\n"))).toBe(true);
    expect(exported.getPage(0).node.Resources()?.lookupMaybe(PDFName.of("Font"), PDFDict)).toBeDefined();
    const cffStreams = exported.context.enumerateIndirectObjects().flatMap(([, object]) => object instanceof PDFRawStream
      && object.dict.get(PDFName.of("Subtype")) === PDFName.of("CIDFontType0C") ? [object] : []);
    expect(cffStreams.length).toBeGreaterThan(0);
    for (const stream of cffStreams) {
      const header = decodePDFRawStream(stream).decode().slice(0, 4);
      expect(header[0]).toBe(1);
      expect(header[3]).toBeGreaterThanOrEqual(1);
      expect(header[3]).toBeLessThanOrEqual(4);
    }
    const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
    const loading = getDocument({ data: bytes.slice() }), pdf = await loading.promise;
    const text = (await (await pdf.getPage(1)).getTextContent()).items.flatMap((item) => "str" in item ? [item.str] : []).join("");
    expect(text).toBe("中文译文 繁體𠮷 日本語 한국어 Русский Ελληνικα");
    expect(text).not.toContain("Original words");
    await loading.destroy();
  }, 20000);
});
