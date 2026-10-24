import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import FinishReviewPanel from "./FinishReviewPanel";

const props = { video: null, currentTime: 10, frameReady: false, busy: false, scanning: false, progress: "",
  onZone() {}, onScan() {}, onCancel() {}, onJump() {} };
describe("finish review controls", () => {
  it("explains the review-only contract and requires a paused frame", () => {
    const html = renderToStaticMarkup(createElement(FinishReviewPanel, props));
    expect(html).toContain("Manual review");
    expect(html).toContain("without changing accepted timing");
    expect(html).toContain("not the scoreboard");
    expect(html).toContain('<button disabled="">Mark finish pad</button>');
    expect(html).toContain('<button disabled="">Rescan near current frame</button>');
  });
  it("exposes cancellation while keeping edits disabled during a rescan", () => {
    const html = renderToStaticMarkup(createElement(FinishReviewPanel, { ...props, busy: true, scanning: true, progress: "Inspecting pad" }));
    expect(html).toContain("Cancel finish rescan");
    expect(html).toContain('role="status">Inspecting pad');
  });
  it("offers a separate indicator scan without treating a marked pad as a sensor", () => {
    const html = renderToStaticMarkup(createElement(FinishReviewPanel, { ...props,
      zone: { id: "finishPad", label: "Finish Pad Review Area", x1: .4, y1: .1, x2: .5, y2: .2 },
      onIndicatorZone() {}, onIndicatorScan() {} }));
    expect(html).toContain('disabled="">Mark finish indicator</button>');
    expect(html).toContain('disabled="">Scan marked indicator</button>');
    expect(html).not.toContain("Clear indicator area");
    expect(html).toContain("This is separate from the pad");
    expect(html).toContain("review the suggested frame before accepting Finish");
  });
  it("requires a fresh marking frame before tracking a saved indicator area", () => {
    const html = renderToStaticMarkup(createElement(FinishReviewPanel, { ...props,
      indicatorZone: { id: "finishIndicator", label: "Finish Indicator Review Area", x1: .4, y1: .1, x2: .5, y2: .2 },
      onIndicatorZone() {}, onIndicatorScan() {}, onIndicatorTrack() {} }));
    expect(html).toContain('disabled="">Track marked indicator</button>');
    expect(html).toContain("Saved areas need a fresh marking frame for tracking");
    expect(html).not.toContain("Accept tracked finish");
  });
});
