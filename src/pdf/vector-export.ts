import { PDFDocument, PDFName, PDFRawStream, PDFContentStream, PDFDict, PDFArray, PDFRef,
  decodePDFRawStream, beginText, endText, setFontAndSize, setTextMatrix, showText,
  setTextRenderingMode, TextRenderingMode, setFillingRgbColor, setStrokingRgbColor,
  setLineWidth, pushGraphicsState, popGraphicsState, type PDFPage } from "pdf-lib";
import { removePdfText } from "./content-stream";
import { pdfExportFontkit } from "./export-font";
import type { RasterPdfPage } from "./export";

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

export async function buildSearchablePdf(pages: RasterPdfPage[], title: string, sourceBytes: Uint8Array | undefined,
  fontBytes: Uint8Array, onFontFallback?: (pages: number[]) => void): Promise<Uint8Array> {
  const output = await PDFDocument.create();
  output.setTitle(title);
  output.setCreator("WuPage");
  output.setProducer("WuPage PDF Translator");
  output.registerFontkit(pdfExportFontkit);
  const hasText = pages.some((page) => !page.scene?.unchanged && page.scene?.text.length);
  const supported = new Set(hasText ? pdfExportFontkit.create(fontBytes).characterSet : []);
  const supportedText = (text: string): boolean => [...text].every(character => supported.has(character.codePointAt(0)!));
  // An empty CFF subset is invalid. Entirely unsupported scripts need only the
  // raster page; do not create an unused font with no encodable text.
  const hasSupportedText = pages.some(page => !page.scene?.unchanged && page.scene?.text.some(run => run.text && supportedText(run.text)));
  const font = hasSupportedText ? await output.embedFont(fontBytes, { subset: true }) : undefined;
  const fontFallbackPages: number[] = [];
  const original = sourceBytes ? await PDFDocument.load(sourceBytes) : undefined;
  const graphics = sourceBytes ? await PDFDocument.load(sourceBytes) : undefined;
  const optionalLayers = graphics?.catalog.has(PDFName.of("OCProperties"));
  const rewritten = new Map<PDFRawStream, PDFRef>();
  for (let index = 0; index < pages.length; index++) {
    const source = pages[index], scene = source.scene;
    if (scene?.unchanged && original) {
      const [page] = await output.copyPages(original, [index]);
      output.addPage(page);
      continue;
    }
    const page = output.addPage([source.width, source.height]);
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
    if (!vector) {
      const image = source.format === "png" ? await output.embedPng(source.imageBytes) : await output.embedJpg(source.imageBytes);
      page.drawImage(image, { x: 0, y: 0, width: source.width, height: source.height });
    }
    if (!scene) continue;
    if (vector) for (const image of scene.images) {
      const embedded = await output.embedPng(image.bytes);
      page.drawImage(embedded, { x: image.x, y: source.height - image.y - image.height, width: image.width, height: image.height });
    }
    if (!font || !scene.text.length) continue;
    const fontName = page.node.newFontDictionary(font.name, font.ref);
    page.pushOperators(pushGraphicsState(), beginText(), setFontAndSize(fontName, 10));
    for (const run of scene.text) {
      if (!run.text || !Number.isFinite(run.x + run.y + run.width + run.size) || run.size <= 0) continue;
      if (!supportedText(run.text)) continue;
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
  const bytes = await output.save({ useObjectStreams: true });
  onFontFallback?.(fontFallbackPages);
  return bytes;
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
