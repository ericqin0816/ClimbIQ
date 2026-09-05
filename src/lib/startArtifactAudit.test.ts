import { describe, expect, it } from "vitest";
import { assessStartLightArtifacts } from "./startArtifactAudit";

const zone = { id: "startLight" as const, label: "Automatic patch", x1: 0.8, x2: 0.83, y1: 0.95, y2: 0.98 };
function frame(width = 160, height = 90, band = true) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const offset = (y * width + x) * 4;
    const value = band && y > height * 0.94 ? 25 : 160 + ((x + y) % 5);
    data.set([value, value, value, 255], offset);
  }
  return { width, height, data };
}
describe("pre-fusion visual artifact audit", () => {
  it("downgrades an automatic patch inside a lower broadcast-like band", () => {
    const before = frame(), after = frame();
    expect(assessStartLightArtifacts(before, after, zone)).toMatchObject({ usableForAutomaticVote: false, possibleOverlay: true });
  });
  it("does not label every low sensor, portrait floor, or manual zone as a graphic", () => {
    for (const [image, candidate, automatic] of [
      [frame(90, 160), zone, true],
      [frame(), { ...zone, y1: 0.7, y2: 0.73 }, true], [frame(), zone, false],
    ] as const) {
      expect(assessStartLightArtifacts(image, image, candidate, automatic).usableForAutomaticVote).toBe(true);
    }
  });
  it("keeps a context-poor landscape-edge patch review-only even without a dark banner", () => {
    const image = frame(160, 90, false);
    expect(assessStartLightArtifacts(image, image, zone)).toMatchObject({
      usableForAutomaticVote: false, possibleOverlay: false, edgeContextMissing: true,
    });
  });
  it("downgrades a camera cut before its light proposals can vote together", () => {
    const before = frame(), after = frame();
    for (let offset = 0; offset < after.data.length; offset += 4) {
      const value = (offset / 4) % 2 ? 20 : 250;
      after.data[offset] = value; after.data[offset + 1] = value; after.data[offset + 2] = value;
    }
    const result = assessStartLightArtifacts(before, after, { ...zone, y1: 0.6, y2: 0.7 });
    expect(result.usableForAutomaticVote).toBe(false);
    expect(result.scene.continuous).toBe(false);
  });
});
