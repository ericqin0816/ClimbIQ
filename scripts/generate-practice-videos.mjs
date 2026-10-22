import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { once } from "node:events";
import { createHash } from "node:crypto";
import path from "node:path";

// Original geometric animation, no third-party footage, fonts, or human likeness.
// CC0-1.0: see public/samples/LICENSE.txt. This is a workflow fixture, not accuracy data.
const encoder = process.env.CLIMBIQ_FFMPEG ?? "ffmpeg";
const width = 240, height = 426, fps = 30, duration = 8;
const out = path.resolve("public/samples");
await mkdir(out, { recursive: true });
const attempts = [
  { id: "a", start: 1, hold10: 3.8, finish: 6.6, color: [243, 166, 77] },
  { id: "b", start: 1, hold10: 3.3, finish: 6.2, color: [115, 209, 214] },
];
const manifest = { version: 1, synthetic: true, license: "CC0-1.0", fps, width, height, duration,
  referenceMethod: "Authored animation frame transitions; no independent human annotation or accuracy claim.", attempts: [] };
for (const attempt of attempts) {
  const file = `climbiq-practice-${attempt.id}.mp4`;
  const child = spawn(encoder, ["-hide_banner", "-loglevel", "error", "-y", "-f", "rawvideo", "-pixel_format", "rgb24", "-video_size", `${width}x${height}`, "-framerate", String(fps), "-i", "pipe:0", "-an", "-c:v", "libx264", "-preset", "medium", "-crf", "23", "-pix_fmt", "yuv420p", "-movflags", "+faststart", path.join(out, file)], { windowsHide: true, stdio: ["pipe", "ignore", "pipe"] });
  let failure = "";
  child.stderr.on("data", chunk => failure += chunk);
  child.stdin.on("error", () => {});
  const closed = once(child, "close");
  for (let frame = 0; frame < fps * duration; frame++) {
    const pixels = Buffer.alloc(width * height * 3);
    const box = (x, y, w, h, rgb) => {
      for (let py = Math.max(0, Math.round(y)); py < Math.min(height, Math.round(y + h)); py++) {
        for (let px = Math.max(0, Math.round(x)); px < Math.min(width, Math.round(x + w)); px++) {
          const i = (py * width + px) * 3; pixels[i] = rgb[0]; pixels[i + 1] = rgb[1]; pixels[i + 2] = rgb[2];
        }
      }
    };
    const circle = (x, y, r, rgb) => {
      for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
        if (dx * dx + dy * dy <= r * r) box(x + dx, y + dy, 1, 1, rgb);
      }
    };
    const line = (x1, y1, x2, y2, rgb) => {
      const steps = Math.ceil(Math.max(Math.abs(x2 - x1), Math.abs(y2 - y1)));
      for (let n = 0; n <= steps; n++) circle(x1 + (x2 - x1) * n / Math.max(1, steps), y1 + (y2 - y1) * n / Math.max(1, steps), 2, rgb);
    };
    box(0, 0, width, height, [20, 29, 36]); box(30, 22, 180, 385, [41, 55, 64]);
    for (let i = 0; i < 19; i++) circle(90 + (i % 2) * 52, 383 - i * 18, 5, [187, 83, 77]);
    const time = frame / fps;
    const started = frame >= Math.round(attempt.start * fps), contacted = frame >= Math.round(attempt.hold10 * fps), finished = frame >= Math.round(attempt.finish * fps);
    circle(48, 387, 8, started ? [63, 214, 132] : [225, 75, 63]);
    box(153, 31, 28, 14, finished ? [63, 214, 132] : [186, 188, 197]);
    circle(142, 220, 9, contacted ? [63, 214, 132] : [234, 194, 65]);
    const y = time < attempt.hold10 ? 374 - Math.max(0, time - attempt.start) / (attempt.hold10 - attempt.start) * 128
      : 246 - Math.min(1, (time - attempt.hold10) / (attempt.finish - attempt.hold10)) * 178;
    const x = 119;
    const c = attempt.color;
    circle(x, y - 24, 8, c); line(x, y - 16, x, y + 11, c);
    line(x, y - 12, 99, y - 31, c); line(x, y - 12, 142, y - 26, c);
    line(x, y + 11, 98, y + 33, c); line(x, y + 11, 140, y + 31, c);
    // Reference contact is explicit, rather than inferred from avatar height.
    if (contacted && !finished) line(142, y - 26, 142, 220, c);
    if (finished) line(142, y - 26, 167, 38, c);
    // Small timeline ticks allow visual inspection at authored frame boundaries.
    box(30, 414, 180 * Math.min(1, time / duration), 4, c);
    if (!child.stdin.write(pixels)) await once(child.stdin, "drain");
  }
  child.stdin.end();
  const [code] = await closed;
  if (code !== 0) throw new Error(failure || `Encoder exited ${code}`);
  manifest.attempts.push({ ...attempt, color: undefined, file, sha256: createHash("sha256").update(await readFile(path.join(out, file))).digest("hex") });
}
await writeFile(path.join(out, "reference.json"), JSON.stringify(manifest, null, 2) + "\n");
console.log("Generated two CC0 synthetic practice recordings and authored reference markers.");
