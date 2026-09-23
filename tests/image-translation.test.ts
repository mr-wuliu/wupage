import { afterEach, describe, expect, it, vi } from "vitest";
import { loadImageData } from "../src/background/image-translation";
import { parseImageRegions } from "../src/background/providers";
import { parseImageRegionResult } from "../src/background/image-regions";

const region = { box: [100, 200, 600, 100], text: "Hello world", translation: "你好，世界", foreground: "#111111", background: "#ffffff", align: "center", bold: true };
afterEach(() => vi.unstubAllGlobals());
describe("image regions and loading", () => {
  it("rejects malformed coordinates and empty translations instead of masking the original", () => {
    for (const invalid of [{ ...region, box: [-10, 0, 20, 20] }, { ...region, box: [900, 0, 200, 20] },
      { ...region, box: [1, 2, 0, 5] }, { ...region, translation: "" }]) {
      expect(() => parseImageRegions(JSON.stringify({ regions: [invalid] }))).toThrow();
    }
    expect(parseImageRegions('{"regions":[]}')).toEqual([]);
    expect(() => parseImageRegions("not JSON")).toThrow();
  });

  it("normalizes numeric strings, named boxes and minor rounding at image edges", () => {
    const result = parseImageRegionResult(JSON.stringify({ regions: [
      { ...region, box: ["100", "200", "600", "100"] },
      { ...region, box: { x: -0.5, y: 980, width: 200, height: 20.5 } }
    ] }));
    expect(result.skippedRegions).toBe(0);
    expect(result.regions[0].box).toEqual(region.box);
    expect(result.regions[1].box).toEqual([0, 980, 199.5, 20]);
  });

  it("converts explicitly declared pixels and corners for the 1251 x 1557 dashboard image", () => {
    const result = parseImageRegionResult(JSON.stringify({ coordinateSystem: "pixels", boxFormat: "xyxy", regions: [
      { ...region, box: [125.1, 311.4, 875.7, 467.1] }
    ] }), { width: 1251, height: 1557 });
    expect(result.skippedRegions).toBe(0);
    result.regions[0].box.forEach((value, index) => expect(value).toBeCloseTo(region.box[index]));
  });

  it("supports declared fractional coordinates and named corner coordinates", () => {
    const result = parseImageRegionResult(JSON.stringify({ coordinate_system: "normalized_1", regions: [
      { ...region, box: { x1: 0.1, y1: 0.2, x2: 0.7, y2: 0.3 } }
    ] }));
    result.regions[0].box.forEach((value, index) => expect(value).toBeCloseTo(region.box[index]));
  });

  it("keeps valid regions and identifies malformed ones without guessing ambiguous coordinates", () => {
    const result = parseImageRegionResult(JSON.stringify({ regions: [region,
      { ...region, box: [700, 200, 950, 240] }, { ...region, translation: "" },
      { ...region, box: [null, 0, 20, 20] }
    ] }));
    expect(result.regions).toEqual([region]);
    expect(result.skippedRegions).toBe(3);
    expect(result.issues.join(" ")).toContain("第 2 个文字区域");
    expect(result.issues.join(" ")).toContain("译文 translation 为空");
  });

  it("downloads authenticated images without passing provider credentials to the image host", async () => {
    const fetchMock = vi.fn(async () => new Response(new Uint8Array([1, 2, 3]), { headers: { "Content-Type": "image/png" } }));
    vi.stubGlobal("fetch", fetchMock);
    expect(await loadImageData("https://mail.example/image.png")).toEqual({ dataUrl: "data:image/png;base64,AQID" });
    expect(fetchMock).toHaveBeenCalledWith("https://mail.example/image.png", expect.objectContaining({ credentials: "include" }));
    await expect(loadImageData("file:///private/image.png")).rejects.toThrow();
  });

  it("rejects oversized downloads and HTML login responses", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("login", { headers: { "Content-Type": "text/html" } })));
    await expect(loadImageData("https://mail.example/image")).rejects.toThrow("登录页面");
    vi.stubGlobal("fetch", vi.fn(async () => new Response("x", { headers: { "Content-Type": "image/png", "Content-Length": String(13 * 1024 * 1024) } })));
    await expect(loadImageData("https://mail.example/image")).rejects.toThrow("过大");
  });
});
