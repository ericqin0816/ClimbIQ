/** Serialized into the isolated test browser; no application-private state. */
export async function auditDecodedSourceFrames() {
  if (typeof VideoFrame !== "function") throw new Error("Native VideoFrame API is unavailable in this browser.");
  const video = document.querySelector("video");
  video.pause();
  const targets = [0.15, 0.18, 0.21, 0.31, 0.47, 1.015, 1.041, 1.101, 2.015, 2.041, 2.115, video.duration * 0.75]
    .filter(time => time < video.duration - 0.001);
  const canvas = document.createElement("canvas");
  canvas.width = 160;
  canvas.height = Math.round(160 * video.videoHeight / video.videoWidth);
  const context = canvas.getContext("2d", { willReadFrequently: true });
  const rows = [], byTimestamp = new Map();
  for (const target of [...targets, ...targets.slice(0, 6).reverse()]) {
    if (Math.abs(video.currentTime - target) > 0.000001 || video.seeking) await new Promise((resolve, reject) => {
      const done = () => { clearTimeout(timer); video.removeEventListener("seeked", done); resolve(); };
      const timer = setTimeout(() => { video.removeEventListener("seeked", done); reject(new Error("Frame audit seek timed out.")); }, 5000);
      video.addEventListener("seeked", done);
      video.currentTime = target;
    });
    const began = performance.now(), frame = new VideoFrame(video);
    let mediaTime, duration;
    try { mediaTime = frame.timestamp / 1_000_000; duration = frame.duration === null ? null : frame.duration / 1_000_000; }
    finally { frame.close(); }
    const captureMs = performance.now() - began;
    if (!Number.isFinite(mediaTime) || mediaTime > video.currentTime + 0.004) throw new Error("Frame metadata is ahead of its seek cursor.");
    if (duration !== null && video.currentTime - mediaTime > duration + 0.005) throw new Error("Seek cursor is outside the reported source-frame interval.");
    context.drawImage(video, 0, 0, canvas.width, canvas.height);
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
    const hash = [...new Uint8Array(await crypto.subtle.digest("SHA-256", pixels))].map(v => v.toString(16).padStart(2, "0")).join("");
    if (byTimestamp.has(mediaTime) && byTimestamp.get(mediaTime) !== hash) throw new Error("Repeated source frame has different decoded pixels.");
    byTimestamp.set(mediaTime, hash);
    rows.push({ target, cursorTime: video.currentTime, mediaTime, durationSeconds: duration, captureMs });
  }
  const frameTime = () => { const frame = new VideoFrame(video); try { return frame.timestamp / 1_000_000; } finally { frame.close(); } };
  const waitForStep = async (direction, previous) => {
    const started = performance.now();
    while (performance.now() - started < 5000) {
      if (!video.seeking && (direction === 1 ? frameTime() > previous : frameTime() < previous)) return frameTime();
      await new Promise(resolve => setTimeout(resolve, 30));
    }
    throw new Error("Source-frame step did not reach the adjacent decoded frame.");
  };
  const stepRoundTrips = [];
  for (const target of [...new Set([0.15, 2.015, video.duration * 0.75])].filter(time => time < video.duration - 0.1)) {
    await new Promise((resolve, reject) => {
      const done = () => { clearTimeout(timer); video.removeEventListener("seeked", done); resolve(); };
      const timer = setTimeout(() => { video.removeEventListener("seeked", done); reject(new Error("Frame-step setup seek timed out.")); }, 5000);
      video.addEventListener("seeked", done); video.currentTime = target;
    });
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const original = frameTime();
    const next = document.querySelector('[data-frame-step="next"]');
    if (!next || next.getAttribute("aria-label") !== "Next decoded frame") throw new Error("Native frame-step controls are unavailable after a decoded seek.");
    next.click();
    const advanced = await waitForStep(1, original);
    await new Promise(resolve => requestAnimationFrame(resolve));
    document.querySelector('[data-frame-step="previous"]').click();
    const returned = await waitForStep(-1, advanced);
    if (returned !== original) throw new Error("Next/previous source-frame round trip did not return to the same frame.");
    stepRoundTrips.push({ target, original, advanced, returned });
  }
  return { samples: rows.length, uniqueSourceFrames: byTimestamp.size, repeatedPixelsMatch: true, sourceFrameStepRoundTrip: true, stepRoundTrips, rows,
    interpretation: "Source-frame identity and seek containment, not event-detection accuracy." };
}
