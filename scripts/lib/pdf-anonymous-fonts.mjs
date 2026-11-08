import assert from 'node:assert/strict';
import { PDFDocument, PDFDict, PDFName } from 'pdf-lib';

// Test fixture transformation only: preserve embedded font programs, encoding,
// widths and page content while removing names used by font-based heuristics.
export async function anonymizePdfFonts(bytes) {
  const document = await PDFDocument.load(bytes), names = new Map();
  for (const [, object] of document.context.enumerateIndirectObjects()) {
    if (!(object instanceof PDFDict)) continue;
    if (object.get(PDFName.of('Type'))?.toString() === '/FontDescriptor') {
      assert.ok(['FontFile', 'FontFile2', 'FontFile3'].some(key => object.has(PDFName.of(key))),
        'Font anonymity test requires embedded fonts to preserve rendering');
    }
    for (const key of ['BaseFont', 'FontName']) {
      const old = object.get(PDFName.of(key));
      if (!(old instanceof PDFName)) continue;
      if (!names.has(old.toString())) names.set(old.toString(), `Opaque${String(names.size).padStart(4, '0')}`);
      object.set(PDFName.of(key), PDFName.of(names.get(old.toString())));
    }
  }
  assert.ok(names.size, 'At least one font must be anonymized');
  return document.save();
}
