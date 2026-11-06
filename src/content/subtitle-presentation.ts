import { subtitlePagePair, subtitlePages } from "../video/subtitle-display";

/** Owns measured screen pages only. Source intervals and translation caches
 * remain in the playback layer, so resizing never triggers another request. */
export class SubtitlePresentation {
  private readonly context = typeof CanvasRenderingContext2D === "undefined" ? null : document.createElement("canvas").getContext("2d");
  private signature = "";
  private pages = { source: [] as string[], translation: [] as string[] };

  constructor(private readonly host: HTMLElement, private readonly caption: HTMLElement) {}

  current(source: string, translation: string, progress: number): { source: string; translation: string } {
    const width = this.caption.clientWidth || (parseFloat(this.host.style.getPropertyValue("--wp-layer-width")) || 640)
      * (parseFloat(this.caption.style.width) || 90) / 100;
    const height = parseFloat(this.host.style.getPropertyValue("--wp-layer-height")) || 360;
    const cap = `${Math.max(14, height * .08)}px`;
    if (this.host.style.getPropertyValue("--wp-caption-font-cap") !== cap) this.host.style.setProperty("--wp-caption-font-cap", cap);
    const rows = ["source", "translation"].map(name => getComputedStyle(this.caption.querySelector(`.${name}`)!));
    const fonts = rows.map(style => `${style.fontWeight || "600"} ${style.fontSize || "22px"} ${style.fontFamily || "sans-serif"}`);
    const textHeight = rows.reduce((sum, style, index) => sum + ((index === 0 ? source : translation) ? (parseFloat(style.fontSize) || 22) * 1.4 : 0), 0);
    const maxLines = Math.max(1, Math.min(2, Math.floor((height * .34 - 17) / (textHeight || 1))));
    if (this.host.style.getPropertyValue("--wp-caption-lines") !== String(maxLines)) this.host.style.setProperty("--wp-caption-lines", String(maxLines));
    const signature = JSON.stringify([source, translation, width, height, fonts, maxLines]);
    if (signature !== this.signature) {
      this.signature = signature;
      const pages = (text: string, index: number) => {
        const size = parseFloat(rows[index].fontSize) || 22;
        if (this.context) this.context.font = fonts[index];
        // The fallback is for environments without canvas, including DOM tests.
        const measure = (value: string) => this.context ? this.context.measureText(value).width
          : [...value].reduce((sum, char) => sum + (/[^\u0000-\u00ff]/u.test(char) ? size : size * .6), 0);
        return subtitlePages(text, Math.max(24, width - 20), measure, maxLines);
      };
      this.pages = { source: pages(source, 0), translation: pages(translation, 1) };
    }
    return subtitlePagePair(this.pages.source, this.pages.translation, progress);
  }
}
