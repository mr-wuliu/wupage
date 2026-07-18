import { describe, expect, it } from "vitest";
import { estimateForegroundColor, type ForegroundColorSample } from "../src/pdf/colors";

describe("PDF translated text color recovery", () => {
  it("keeps black text black instead of averaging anti-aliased gray edges", () => {
    const samples: ForegroundColorSample[] = [
      ...repeatSample([8, 8, 8], [255, 255, 255], 20),
      ...repeatSample([92, 92, 92], [255, 255, 255], 50),
      ...repeatSample([176, 176, 176], [255, 255, 255], 70)
    ];

    expect(estimateForegroundColor(samples)).toEqual([8, 8, 8]);
  });

  it("preserves saturated source colors on a white background", () => {
    const samples: ForegroundColorSample[] = [
      ...repeatSample([0, 112, 192], [255, 255, 255], 24),
      ...repeatSample([82, 158, 210], [255, 255, 255], 60),
      ...repeatSample([171, 205, 229], [255, 255, 255], 80)
    ];

    const color = estimateForegroundColor(samples)!;
    expect(color[0]).toBeLessThan(20);
    expect(color[1]).toBeGreaterThanOrEqual(105);
    expect(color[1]).toBeLessThanOrEqual(120);
    expect(color[2]).toBeGreaterThanOrEqual(185);
  });

  it("recovers light text from a dark background", () => {
    const samples: ForegroundColorSample[] = [
      ...repeatSample([248, 248, 248], [24, 36, 33], 18),
      ...repeatSample([170, 174, 173], [24, 36, 33], 45),
      ...repeatSample([90, 98, 95], [24, 36, 33], 60)
    ];

    const color = estimateForegroundColor(samples)!;
    expect(color[0]).toBeGreaterThan(235);
    expect(color[1]).toBeGreaterThan(235);
    expect(color[2]).toBeGreaterThan(235);
  });
});

function repeatSample(
  color: ForegroundColorSample["color"],
  background: ForegroundColorSample["background"],
  count: number
): ForegroundColorSample[] {
  return Array.from({ length: count }, () => ({ color, background }));
}
