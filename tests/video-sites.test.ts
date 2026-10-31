// @vitest-environment jsdom
import { describe, expect, it, vi, afterEach } from "vitest";
import { bilibiliCues, parseCatalogue, validSubtitleCues, youtubeCues } from "../src/video/site-cues";
import { VIDEO_PLATFORMS, mediaKey, playerContainer, renderedCaption, videoPlatform } from "../src/video/platforms";
import { normalizeVideoTranslation, sameVideoLanguage } from "../src/shared/video";

afterEach(() => { document.body.replaceChildren(); vi.restoreAllMocks(); });
describe("site subtitle data", () => {
  it("keeps YouTube mobile caption siblings inside the player scope", () => {
    document.body.innerHTML = '<div id="player-container-id"><div id="player" style="position:relative"><video></video></div><div class="ytp-caption-window-container"><span class="caption-visual-line">Mobile caption</span></div></div>';
    vi.spyOn(HTMLElement.prototype, 'getClientRects').mockReturnValue([new DOMRect(0, 0, 360, 200)] as unknown as DOMRectList);
    const container = playerContainer(document.querySelector('video')!, VIDEO_PLATFORMS[0]);
    expect(container).toBe(document.querySelector('#player-container-id'));
    expect(renderedCaption(container, VIDEO_PLATFORMS[0])).toBe('Mobile caption');
  });
  it("places controls outside Vimeo's accessibility-hidden picture wrapper", () => {
    document.body.innerHTML = '<div id="player" class="player"><div class="vp-video-wrapper" aria-hidden="true"><video></video></div><div class="vp-captions">Current source</div></div>';
    expect(playerContainer(document.querySelector('video')!, VIDEO_PLATFORMS.find(p => p.id === 'vimeo'))).toBe(document.querySelector('#player'));
  });
  it("does not escape a site modal that hides the entire player", () => {
    document.body.innerHTML = '<section aria-hidden="true"><div class="player"><div class="vp-video-wrapper"><video></video></div></div></section>';
    expect(playerContainer(document.querySelector('video')!, VIDEO_PLATFORMS.find(p => p.id === 'vimeo'))).toBe(document.querySelector('.vp-video-wrapper'));
  });
  it("parses YouTube caption timing, markup and ASR append events without overlapping windows", () => {
    expect(youtubeCues({ events: [
      { tStartMs: 1000, dDurationMs: 3000, segs: [{ utf8: "Hello" }] },
      { tStartMs: 1200, dDurationMs: 2500, aAppend: 1, segs: [{ utf8: "world" }] },
      { tStartMs: 3000, dDurationMs: 2000, segs: [{ utf8: "<i>Later</i>" }] }
    ] })).toEqual([{ start: 1, end: 3, text: "Hello world" }, { start: 3, end: 5, text: "Later" }]);
  });
  it("parses Bilibili subtitle JSON with seconds, rejecting invalid cues", () => {
    expect(bilibiliCues({ body: [{ from: 1.2, to: 3.4, content: "你好 &amp; hello" }, { from: -1, to: 2, content: "bad" }] }))
      .toEqual([{ start: 1.2, end: 3.4, text: "你好 & hello" }]);
    expect(validSubtitleCues([{ start: 0, end: Infinity, text: "bad" }, { start: 5, end: 1, text: "bad" }])).toEqual([]);
    expect(() => validSubtitleCues(new Array(20001))).toThrow();
  });
  it("validates bridge tracks and does not accept unbounded page data", () => {
    expect(parseCatalogue({ key: "youtube:id", tracks: [{ id: "en", language: "en", label: "English" }, { id: 5, language: "en", label: "bad" }] })?.tracks).toHaveLength(1);
    expect(parseCatalogue({ key: "x", tracks: new Array(201) })).toBeUndefined();
  });
  it("matches site domain boundaries and distinguishes video and part navigation", () => {
    expect(videoPlatform("www.youtube.com")?.id).toBe("youtube");
    expect(videoPlatform("youtube.com.evil.test")).toBeUndefined();
    expect(videoPlatform("player.bilibili.com")?.id).toBe("bilibili");
    expect(mediaKey("https://www.youtube.com/watch?v=one&t=20s")).toBe(mediaKey("https://www.youtube.com/watch?v=one"));
    expect(mediaKey("https://www.bilibili.com/video/BV123?p=2")).not.toBe(mediaKey("https://www.bilibili.com/video/BV123?p=1"));
  });
  it("reads YouTube visual lines and the current Bilibili major subtitle group without menus", () => {
    document.body.innerHTML = '<div id="movie_player"><div class="ytp-caption-window-container"><span class="caption-visual-line"><span>Hello</span></span><span class="caption-visual-line">world</span></div><div class="ytp-subtitles-menu">Japanese</div></div>';
    vi.spyOn(HTMLElement.prototype, "getClientRects").mockReturnValue([new DOMRect(0, 0, 200, 40)] as unknown as DOMRectList);
    expect(renderedCaption(document.querySelector("#movie_player")!, VIDEO_PLATFORMS[0])).toBe("Hello\nworld");
    document.body.innerHTML = '<div class="bpx-player-container"><div class="bili-subtitle-x-subtitle-panel-major-group"><span>字幕文本</span></div><div class="bpx-player-ctrl-subtitle-menu">中文</div></div>';
    expect(renderedCaption(document.querySelector(".bpx-player-container")!, VIDEO_PLATFORMS[1])).toBe("字幕文本");
  });
  it("reads Udemy's current preview captions without including course language labels or controls", () => {
    document.body.innerHTML = '<aside data-purpose="caption">English, French and other course languages</aside><div data-purpose="media-player-container" style="position:relative"><video></video><div class="_caption-container_nnobv_16" role="status"><div class="_cue-text_nnobv_32">Hello from the course.</div></div><button class="_control-captions_16d8l_125">Subtitles</button></div>';
    vi.spyOn(HTMLElement.prototype, "getClientRects").mockReturnValue([new DOMRect(0, 0, 200, 40)] as unknown as DOMRectList);
    const platform = videoPlatform('www.udemy.com');
    expect(renderedCaption(document.querySelector('[data-purpose="media-player-container"]')!, platform)).toBe('Hello from the course.');
  });
  it("normalizes display preferences and keeps Simplified/Traditional Chinese separate", () => {
    expect(normalizeVideoTranslation({ fontSize: 999, background: "url(x)", enabledSites: ["youtube", "youtube", "evil/*"] }))
      .toEqual({ enabled: true, fontSize: 22, background: "soft", enabledSites: ["youtube"], showOriginal: true, preferredSource: "auto" });
    expect(sameVideoLanguage("en-US", "en")).toBe(true);
    expect(sameVideoLanguage("zh-Hans", "zh-CN")).toBe(true);
    expect(sameVideoLanguage("zh-TW", "zh-CN")).toBe(false);
    expect(sameVideoLanguage("auto", "en")).toBe(false);
  });
});
