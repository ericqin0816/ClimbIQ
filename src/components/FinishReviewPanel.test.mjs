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
});
