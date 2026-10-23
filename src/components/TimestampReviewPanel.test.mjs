import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import TimestampReviewPanel from "./TimestampReviewPanel";

const props = {
  label: "Hold 10 contact review", confidence: "Low", suggestedRawTime: 11.501,
  currentTime: 11.501, frameStatus: "available", frameReady: true, busy: false,
  acceptLabel: "Set Hold 10", onReturn() {}, onAccept() {}, onClose() {},
};
const render = overrides => renderToStaticMarkup(createElement(TimestampReviewPanel, { ...props, ...overrides }));
describe("timestamp review panel", () => {
  it("shows the native frame time separately from the suggested cursor", () => {
    const html = render({ decodedRawTime: 11.47 });
    expect(html).toContain('data-frame-time-source="presentation"');
    expect(html).toContain("Decoded frame");
    expect(html).toContain("Set Hold 10 at 11.470s");
    expect(html).toContain("−0.031s");
    expect(html).toContain('aria-labelledby="timestamp-review-title"');
  });
  it("labels an unusable or unsupported native timestamp as cursor fallback", () => {
    for (const frameStatus of ["unsupported", "unavailable", "available"]) {
      const html = render({ frameStatus });
      expect(html).toContain("Cursor (approx.)");
      expect(html).toContain("native frame time unavailable");
      expect(html).toContain("Set Hold 10 at 11.501s");
      expect(html).not.toContain('data-frame-time-source="presentation"');
    }
  });
  it("disables acceptance during pending decode, playback or analysis", () => {
    for (const overrides of [{ frameStatus: "pending" }, { frameReady: false }, { busy: true }]) {
      const html = render(overrides);
      expect(html).toContain('class="primary" disabled=""');
      expect(html).toContain("Pause and wait for the frame");
    }
  });
  it("keeps detailed time limitations collapsed without hiding fallback provenance", () => {
    const html = render({ frameStatus: "unsupported" });
    expect(html).toContain('<details class="review-time-details">');
    expect(html).toContain("not the exact physical contact instant");
    expect(html).toContain("may not enumerate every encoded frame");
    expect(html).toContain("Approximate cursor time");
  });
  it("reports source-frame duration without calling it event accuracy", () => {
    const html = render({ decodedRawTime: 11.47, sourceFrameDurationSeconds: 1 / 15 });
    expect(html).toContain("66.67");
    expect(html).toContain("not a measured event-error bound");
  });
  it("offers an explicitly collapsed precise-seek action without changing the displayed frame", () => {
    const html = render({ decodedRawTime: 11.47, onJumpToTime() {} });
    expect(html).toContain('aria-label="Jump to time"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain("Decoded frame");
    expect(html).toContain("Set Hold 10 at 11.470s");
    expect(html).not.toContain("Raw video time (seconds)");
  });
  it("does not offer an unavailable seek action, and disables it while analysis owns the video", () => {
    expect(render()).not.toContain('aria-label="Jump to time"');
    const html = render({ busy: true, onJumpToTime() {} });
    expect(html).toContain('class="review-seek-toggle" disabled=""');
    expect(html).toContain('class="primary" disabled=""');
  });
  it("keeps precise seeking disabled until the current displayed frame is ready", () => {
    for (const pending of [{ frameReady: false }, { frameStatus: "pending" }]) {
      const html = render({ onJumpToTime() {}, ...pending });
      expect(html).toContain('aria-disabled="true"');
    }
    // Unsupported native timing still permits ready approximate cursor review.
    expect(render({ onJumpToTime() {}, frameStatus: "unsupported" })).toContain('aria-disabled="false"');
  });
});
