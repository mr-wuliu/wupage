import fontkit, { type Glyph, type Subset } from "@pdf-lib/fontkit";

interface FontDictionary {
  FontName?: unknown;
  Private?: { Subrs?: unknown[]; [key: string]: unknown };
  [key: string]: unknown;
}

// Internal CFF hooks in the pinned @pdf-lib/fontkit 1.1.1. Keep these repairs
// local to export fonts; the library's TrueType subset path is unchanged.
interface CffSubset extends Subset {
  cff: {
    isCIDFont: boolean;
    topDict: { FDArray: FontDictionary[] };
    fdForGlyph(gid: number): number | null;
  };
  glyphs: number[];
  font: { getGlyph(gid: number): Glyph & { _usedSubrs: Record<string, boolean> } };
  subsetSubrs(subrs: unknown[], used: Record<string, boolean>): Uint8Array[];
  subsetFontdict(topDict: { FDArray: FontDictionary[]; FDSelect: { version: number; fds: number[] } }): void;
}

export const pdfExportFontkit = { create: (data: Uint8Array) => {
  const font = fontkit.create(data);
  const createSubset = font.createSubset.bind(font);
  font.createSubset = () => {
    const original = createSubset();
    if (!("cff" in original) || !original.cff) return original;
    const subset = original as CffSubset;
    if (subset.cff.isCIDFont) subset.subsetFontdict = (topDict) => {
      const indices = new Map<number, number>();
      const usedSubrs: Record<string, boolean>[] = [];
      topDict.FDArray = [];
      topDict.FDSelect = { version: 0, fds: [] };
      for (const gid of subset.glyphs) {
        const fd = subset.cff.fdForGlyph(gid);
        if (fd === null) throw new Error("Missing CFF font dictionary");
        let index = indices.get(fd);
        if (index === undefined) {
          index = topDict.FDArray.length;
          indices.set(fd, index);
          topDict.FDArray.push({ ...subset.cff.topDict.FDArray[fd] });
          usedSubrs.push({});
        }
        // Upstream uses the last dictionary for every repeated FD. Mixed
        // scripts revisit earlier FDs: both selection and local subroutine
        // retention must use that FD's mapped index instead.
        topDict.FDSelect.fds.push(index);
        const glyph = subset.font.getGlyph(gid);
        void glyph.path; // Parses the glyph and discovers its subroutine calls.
        Object.assign(usedSubrs[index], glyph._usedSubrs);
      }
      for (const [index, dict] of topDict.FDArray.entries()) {
        delete dict.FontName;
        if (dict.Private?.Subrs) dict.Private = {
          ...dict.Private, Subrs: subset.subsetSubrs(dict.Private.Subrs, usedSubrs[index])
        };
      }
    };
    const encodeStream = subset.encodeStream.bind(subset);
    subset.encodeStream = () => {
      const stream = encodeStream();
      let offset = 0;
      stream.on("data", (chunk: Uint8Array) => {
        // fontkit writes the CFF byte length as header offSize. Only 1..4
        // are valid; 4 keeps strict readers from rejecting the subset.
        if (offset <= 3 && offset + chunk.length > 3 && chunk[3 - offset] > 4) chunk[3 - offset] = 4;
        offset += chunk.length;
      });
      return stream;
    };
    return subset;
  };
  return font;
} };
