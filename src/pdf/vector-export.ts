import { PDFDocument, PDFName, PDFRawStream, PDFContentStream, PDFDict, PDFArray, PDFRef, PDFNumber, PDFString, PDFHexString,
  decodePDFRawStream, beginText, endText, setFontAndSize, setTextMatrix, showText,
  setTextRenderingMode, TextRenderingMode, setFillingRgbColor, setStrokingRgbColor,
  setLineWidth, pushGraphicsState, popGraphicsState, type PDFPage, type PDFFont } from "pdf-lib";
import { removePdfText } from "./content-stream";
import { pdfExportFontkit } from "./export-font";
import { drawRasterPdfPage, type RasterPdfPage } from "./export";
import { t } from "../shared/i18n";

export interface PdfExportText {
  text: string;
  x: number;
  y: number;
  width: number;
  size: number;
  color: [number, number, number];
  bold?: boolean;
  invisible?: boolean;
}

export interface PdfExportImage {
  bytes: Uint8Array;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PdfExportScene {
  text: PdfExportText[];
  images: PdfExportImage[];
  transform: number[];
  unchanged: boolean;
}

export async function buildSearchablePdf(pages: Iterable<RasterPdfPage> | AsyncIterable<RasterPdfPage>, title: string, sourceBytes: Uint8Array | undefined,
  fontBytes: Uint8Array, onFontFallback?: (pages: number[]) => void): Promise<Uint8Array> {
  const output = await PDFDocument.create();
  output.setTitle(title);
  output.setCreator("WuPage");
  output.setProducer("WuPage PDF Translator");
  output.registerFontkit(pdfExportFontkit);
  let supported: Set<number> | undefined;
  let font: PDFFont | undefined;
  const fontFallbackPages: number[] = [];
  const original = sourceBytes ? await PDFDocument.load(sourceBytes) : undefined;
  const graphics = sourceBytes ? await PDFDocument.load(sourceBytes) : undefined;
  const optionalLayers = graphics?.catalog.has(PDFName.of("OCProperties"));
  const rewritten = new Map<PDFRawStream, PDFRef>();
  for await (const source of pages) {
    const index = output.getPageCount(), scene = source.scene;
    if (scene?.unchanged && original) {
      const [page] = await output.copyPages(original, [index]);
      output.addPage(page);
      continue;
    }
    const page = output.addPage([source.width, source.height]);
    const originalPage = original?.getPage(index);
    if (originalPage && scene) copyExternalLinks(originalPage, page, scene.transform);
    if (scene?.text.length) supported ??= new Set(pdfExportFontkit.create(fontBytes).characterSet);
    const supportedText = (text: string): boolean => [...text].every(character => supported?.has(character.codePointAt(0)!));
    // A valid font file need not cover the target script or punctuation.
    // Preserve the complete browser-rendered page instead of drawing .notdef
    // boxes. Only supported text is added to the invisible search layer.
    const fontFallback = Boolean(scene?.text.some(run => !run.invisible && !supportedText(run.text)));
    if (fontFallback) fontFallbackPages.push(index + 1);
    let vector = false;
    if (graphics && scene && !optionalLayers && !fontFallback) {
      const sourcePage = graphics.getPage(index);
      if (stripPageText(sourcePage, rewritten)) {
        const crop = sourcePage.getCropBox(), v = scene.transform;
        const embedded = await output.embedPage(sourcePage,
          { left: crop.x, bottom: crop.y, right: crop.x + crop.width, top: crop.y + crop.height },
          v.length === 6 ? [v[0], -v[1], v[2], -v[3], v[4], source.height - v[5]] : undefined);
        page.drawPage(embedded, { x: 0, y: 0, xScale: 1, yScale: 1 });
        vector = true;
      }
    }
    if (!vector) await drawRasterPdfPage(page, source);
    if (!scene) continue;
    if (vector) for (const image of scene.images) {
      const embedded = await output.embedPng(image.bytes);
      page.drawImage(embedded, { x: image.x, y: source.height - image.y - image.height, width: image.width, height: image.height });
    }
    const encodable = scene.text.filter(run => run.text && Number.isFinite(run.x + run.y + run.width + run.size)
      && run.size > 0 && supportedText(run.text));
    if (!encodable.length) continue;
    // An empty CFF subset is invalid. Embed the font once a glyph will be used.
    font ??= await output.embedFont(fontBytes, { subset: true });
    const fontName = page.node.newFontDictionary(font.name, font.ref);
    page.pushOperators(pushGraphicsState(), beginText(), setFontAndSize(fontName, 10));
    for (const run of encodable) {
      const encoded = font.encodeText(run.text);
      const natural = font.widthOfTextAtSize(run.text, run.size);
      const [r, g, b] = run.color;
      page.pushOperators(setTextRenderingMode(!vector || run.invisible ? TextRenderingMode.Invisible
        : run.bold ? TextRenderingMode.FillAndOutline : TextRenderingMode.Fill),
      setLineWidth(run.size * 0.018), setFillingRgbColor(r, g, b), setStrokingRgbColor(r, g, b),
      setFontAndSize(fontName, run.size),
      setTextMatrix(natural > 0 ? run.width / natural : 1, 0, 0, 1, run.x, source.height - run.y), showText(encoded));
    }
    page.pushOperators(endText(), popGraphicsState());
  }
  if (!output.getPageCount()) throw new Error(t("noPdfPagesToExport"));
  const bytes = await output.save({ useObjectStreams: true });
  onFontFallback?.(fontFallbackPages);
  return bytes;
}

function copyExternalLinks(source: PDFPage, target: PDFPage, transform: number[]): void {
  if (transform.length !== 6 || !transform.every(Number.isFinite)) return;
  const annotations = source.node.lookup(PDFName.of("Annots"));
  if (!(annotations instanceof PDFArray)) return;
  const [a, b, c, d, e, f] = transform;
  const { width, height } = target.getSize();
  for (let i = 0; i < annotations.size(); i++) {
    const entry = annotations.lookup(i);
    if (!(entry instanceof PDFDict) || entry.get(PDFName.of("Subtype")) !== PDFName.of("Link")) continue;
    const action = entry.lookup(PDFName.of("A")), rect = entry.lookup(PDFName.of("Rect"));
    if (!(action instanceof PDFDict) || action.get(PDFName.of("S")) !== PDFName.of("URI")
      || !(rect instanceof PDFArray) || rect.size() !== 4) continue;
    const value = action.lookup(PDFName.of("URI"));
    if (!(value instanceof PDFString || value instanceof PDFHexString)) continue;
    let address: URL;
    try { address = new URL(value.decodeText()); } catch { continue; }
    if (address.protocol !== "http:" && address.protocol !== "https:") continue;
    const coords = [0, 1, 2, 3].map(index => rect.lookup(index));
    if (!coords.every(coord => coord instanceof PDFNumber)) continue;
    const values = coords.map(coord => coord.asNumber());
    if (!values.every(Number.isFinite)) continue;
    const [left, bottom, right, top] = values;
    const corners = [[left, bottom], [left, top], [right, bottom], [right, top]]
      .map(([x, y]) => [a * x + c * y + e, height - (b * x + d * y + f)]);
    const xs = corners.map(([x]) => x), ys = corners.map(([, y]) => y);
    const bounds = [Math.max(0, Math.min(...xs)), Math.max(0, Math.min(...ys)),
      Math.min(width, Math.max(...xs)), Math.min(height, Math.max(...ys))];
    if (bounds[0] >= bounds[2] || bounds[1] >= bounds[3]) continue;
    const context = target.doc.context;
    // URI actions use URL bytes. A UTF-16 text string is not a usable URI in PDF readers.
    const uri = PDFHexString.of(Array.from(new TextEncoder().encode(address.href),
      byte => byte.toString(16).padStart(2, "0")).join(""));
    target.node.addAnnot(context.register(context.obj({
      Type: "Annot", Subtype: "Link", Rect: bounds, Border: [0, 0, 0],
      A: { Type: "Action", S: "URI", URI: uri }
    })));
  }
}

function stripPageText(page: PDFPage, rewritten: Map<PDFRawStream, PDFRef>): boolean {
  const context = page.doc.context;
  const rewriteResources = (resources?: PDFDict, visiting = new Set<PDFRawStream>()): boolean => {
    const xobjects = resources?.lookupMaybe(PDFName.of("XObject"), PDFDict);
    for (const [name, reference] of xobjects?.entries() ?? []) {
      const stream = context.lookup(reference);
      if (!(stream instanceof PDFRawStream) || stream.dict.get(PDFName.of("Subtype")) !== PDFName.of("Form")) continue;
      if (rewritten.has(stream)) { xobjects!.set(name, rewritten.get(stream)!); continue; }
      if (visiting.has(stream)) return false;
      visiting.add(stream);
      const content = removePdfText(decodePDFRawStream(stream).decode());
      if (!content || !rewriteResources(stream.dict.lookupMaybe(PDFName.of("Resources"), PDFDict), visiting)) return false;
      const replacement = context.flateStream(content);
      for (const [key, value] of stream.dict.entries()) {
        if (!["/Length", "/Filter", "/DecodeParms"].includes(key.toString())) replacement.dict.set(key, value);
      }
      const ref = context.register(replacement);
      rewritten.set(stream, ref);
      xobjects!.set(name, ref);
      visiting.delete(stream);
    }
    resources?.delete(PDFName.of("Font"));
    return true;
  };
  const contents = page.node.Contents();
  const streams = contents instanceof PDFArray
    ? Array.from({ length: contents.size() }, (_, index) => contents.lookup(index)) : contents ? [contents] : [];
  const filtered: Uint8Array[] = [];
  try {
    for (const stream of streams) {
      const raw = stream instanceof PDFRawStream ? decodePDFRawStream(stream).decode()
        : stream instanceof PDFContentStream ? stream.getUnencodedContents() : undefined;
      const clean = raw && removePdfText(raw);
      if (!clean) return false;
      filtered.push(clean);
    }
    if (!rewriteResources(page.node.Resources())) return false;
    page.node.set(PDFName.of("Contents"), context.obj(filtered.map((bytes) => context.register(context.flateStream(bytes)))));
    return true;
  } catch { return false; }
}
