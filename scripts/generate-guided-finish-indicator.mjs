import { spawn } from "node:child_process";
import { once } from "node:events";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, rmdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

// Original CC0 graphics and audio. This fixture verifies a conditional review
// workflow; its authored clocks do not measure real-climber detection accuracy.
const option = key => process.argv.find(arg => arg.startsWith(`--${key}=`))?.slice(key.length + 3);
const variant = option("variant") ?? "baseline";
if (!["baseline", "constant", "scene-cut", "nearblack"].includes(variant)) throw new Error("Unknown fixture variant");
const audioProfile = option("audio-profile") ?? "default";
if (!["default", "secondary"].includes(audioProfile) || audioProfile === "secondary" && variant !== "baseline") throw new Error("Unknown audio fixture profile");
const encoder = process.env.CLIMBIQ_FFMPEG ?? "ffmpeg";
const width = 320, height = 180, fps = 30, duration = 10;
const start = 2.4, launch = 2.7, finish = 7, decoyFinish = 5.5;
const before = [40, 180, 80], after = [190, 50, 45];
const out = path.resolve(option("output-dir") ?? "e2e/fixtures");
const stem = audioProfile === "secondary" ? "audio-start-review" : variant === "baseline" ? "guided-finish-indicator" : `guided-finish-indicator-${variant}`;
await mkdir(out, { recursive: true });
const temp = await mkdtemp(path.join(tmpdir(), "climbiq-finish-indicator-"));
const audio = path.join(temp, "tones.wav"), file = path.join(out, `${stem}.mp4`);
const rate = 24000, pcm = Buffer.alloc(duration * rate * 2), header = Buffer.alloc(44);
const pitch = audioProfile === "secondary" ? 880 : 550;
const tones = [[0.4, pitch], [1.4, pitch], [start, pitch * 2]];
for (const [onset, frequency] of tones) for (let sample = 0; sample < rate * 0.14; sample++) {
  const time = sample / rate, envelope = Math.min(1, time / 0.005, (0.14 - time) / 0.005);
  pcm.writeInt16LE(Math.round(14000 * envelope * Math.sin(2 * Math.PI * frequency * time)), (Math.round(onset * rate) + sample) * 2);
}
header.write("RIFF"); header.writeUInt32LE(36 + pcm.length, 4); header.write("WAVEfmt ", 8);
header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
header.writeUInt32LE(rate, 24); header.writeUInt32LE(rate * 2, 28); header.writeUInt16LE(2, 32);
header.writeUInt16LE(16, 34); header.write("data", 36); header.writeUInt32LE(pcm.length, 40);
await writeFile(audio, Buffer.concat([header, pcm]));
let errorText = "";
const child = spawn(encoder, ["-hide_banner", "-loglevel", "error", "-y", "-f", "rawvideo", "-pixel_format", "rgb24",
  "-video_size", `${width}x${height}`, "-framerate", String(fps), "-i", "pipe:0", "-i", audio,
  "-c:v", "libx264", "-preset", "medium", "-crf", "18", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "64k",
  "-t", String(duration), "-movflags", "+faststart", file], { windowsHide: true, stdio: ["pipe", "ignore", "pipe"] });
child.stderr.on("data", data => errorText += data); child.stdin.on("error", () => {});
const closed = once(child, "close");
for (let frame = 0; frame < fps * duration; frame++) {
  const pixels = Buffer.alloc(width * height * 3), time = frame / fps;
  const box = (x, y, w, h, color) => {
    for (let py = Math.max(0, Math.round(y)); py < Math.min(height, Math.round(y + h)); py++)
      for (let px = Math.max(0, Math.round(x)); px < Math.min(width, Math.round(x + w)); px++) {
        const offset = (py * width + px) * 3;
        pixels[offset] = color[0]; pixels[offset + 1] = color[1]; pixels[offset + 2] = color[2];
      }
  };
  const sceneCut = variant === "scene-cut" && time >= 6.7;
  box(0, 0, width, height, sceneCut ? [130, 92, 70] : [45, 48, 52]);
  box(158, 0, 4, height, sceneCut ? [70, 120, 100] : [78, 80, 84]);
  // Distributed wall markings make a constructed camera cut structurally visible.
  for (let row = 0; row < 6; row++) for (let column = 0; column < 12; column++)
    box(5 + column * 27, 4 + row * 29, 8, 7, sceneCut ? [180, 140, 90] : [64, 67, 71]);
  for (const x of [78, 242]) {
    const y = 150 - Math.min(1, Math.max(0, (time - launch) / 4)) * 56;
    box(x - 3, y - 15, 6, 6, [210, 210, 210]); box(x - 3, y - 8, 6, 16, [210, 210, 210]);
    box(x - 10, y - 5, 20, 3, [210, 210, 210]);
    box(x - 7, y + 7, 3, 12, [210, 210, 210]); box(x + 4, y + 7, 3, 12, [210, 210, 210]);
    box(x - 5, 163, 10, 7, time < start ? [25, 195, 45] : [25, 45, 205]);
  }
  box(72, 92, 12, 10, time < decoyFinish ? before : after);
  let selected = before;
  if (variant === "nearblack" && time >= finish) selected = [2, 0, 0];
  else if (variant !== "constant" && time >= finish) selected = after;
  else if (time >= 6.8 && variant === "baseline") selected = before.map(value => Math.round(value * 0.55));
  box(236, 92, 12, 10, selected);
  if (!child.stdin.write(pixels)) await once(child.stdin, "drain");
}
child.stdin.end();
const [code] = await closed;
await rm(audio); await rmdir(temp);
if (code !== 0) throw new Error(errorText || `Encoder exited ${code}`);
const probe = spawn(encoder, ["-hide_banner", "-i", file, "-an", "-vf", "showinfo", "-f", "null", "-"],
  { windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
let info = ""; probe.stderr.on("data", data => info += data);
const [probeCode] = await once(probe, "close");
const points = [...info.matchAll(/\bn:\s*(\d+).*?pts_time:\s*([\d.]+)/g)].map(match => Number(match[2]));
if (probeCode !== 0 || points.length !== fps * duration || points.some((pts, index) => Math.abs(pts - index / fps) > 0.00001))
  throw new Error("Encoded fixture did not preserve the authored source PTS grid");
const metadata = { version: 1, synthetic: true, workflowOnly: true, license: "CC0-1.0", variant,
  width, height, fps, duration, sha256: createHash("sha256").update(await readFile(file)).digest("hex"),
  authoredStart: start, authoredLaunch: launch,
  authoredFinishIndicator: variant === "constant" || variant === "nearblack" ? null : finish,
  oppositeLaneIndicator: decoyFinish, selectedIndicatorRegion: { x1: 0.7, y1: 0.48, x2: 0.82, y2: 0.62 },
  selectedIndicatorPixelRect: [236, 92, 248, 102],
  sourceHueShadow: variant === "baseline" ? { start: 6.8, end: finish, brightnessFactor: 0.55 } : null,
  tones: tones.map(([onset, frequency]) => ({ onset, frequency })),
  ...(audioProfile === "secondary" ? { audioProfile: "secondary-880-1760" } : {}),
  referenceMethod: "Original generated graphics, sampled color change and synthesized audio. No real people, pad contact, independent human labels, or physical timing calibration.",
  reproduction: `CLIMBIQ_FFMPEG=<ffmpeg> node scripts/generate-guided-finish-indicator.mjs${audioProfile === "secondary" ? " --audio-profile=secondary" : ""}`,
  decodedSourcePTS: { frames: points.length, first: points[0], last: points.at(-1), checkedAgainstAuthoredGrid: true, maxToleranceSeconds: 0.00001 } };
await writeFile(path.join(out, `${stem}.reference.json`), JSON.stringify(metadata, null, 2) + "\n");
console.log(JSON.stringify({ file, bytes: (await readFile(file)).length, sha256: metadata.sha256, frames: points.length, variant }));
