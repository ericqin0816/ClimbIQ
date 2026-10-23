import { spawn } from "node:child_process";
import { once } from "node:events";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, rmdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

// Original CC0 geometry/audio. An authored workflow fixture, never evidence of
// real climber identity, physical contact, or detector accuracy. Not user practice.
const encoder = process.env.CLIMBIQ_FFMPEG ?? "ffmpeg";
const width = 160, height = 284, fps = 30, duration = 8, start = 1.4, launch = 1.7;
const out = path.resolve("e2e/fixtures"), temp = await mkdtemp(path.join(tmpdir(), "climbiq-dual-lane-"));
await mkdir(out, { recursive: true });
const audio = path.join(temp, "tones.wav"), file = path.join(out, "dual-lane.mp4");
const rate = 24000, pcm = Buffer.alloc(duration * rate * 2), header = Buffer.alloc(44);
for (const [onset, frequency] of [[.4, 550], [.9, 550], [start, 1100]]) {
  for (let sample = 0; sample < rate * .14; sample++) {
    const t = sample / rate, envelope = Math.min(1, t / .005, (.14 - t) / .005);
    pcm.writeInt16LE(Math.round(15000 * envelope * Math.sin(2 * Math.PI * frequency * t)), (Math.round(onset * rate) + sample) * 2);
  }
}
header.write("RIFF"); header.writeUInt32LE(36 + pcm.length, 4); header.write("WAVEfmt ", 8);
header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
header.writeUInt32LE(rate, 24); header.writeUInt32LE(rate * 2, 28); header.writeUInt16LE(2, 32);
header.writeUInt16LE(16, 34); header.write("data", 36); header.writeUInt32LE(pcm.length, 40);
await writeFile(audio, Buffer.concat([header, pcm]));
const args = ["-hide_banner", "-loglevel", "error", "-y", "-f", "rawvideo", "-pixel_format", "rgb24",
  "-video_size", `${width}x${height}`, "-framerate", String(fps), "-i", "pipe:0", "-i", audio,
  "-c:v", "libx264", "-preset", "medium", "-crf", "18", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "64k",
  "-t", String(duration), "-movflags", "+faststart", file];
const child = spawn(encoder, args, { windowsHide: true, stdio: ["pipe", "ignore", "pipe"] });
let errors = ""; child.stderr.on("data", data => errors += data); child.stdin.on("error", () => {});
const closed = once(child, "close");
for (let frame = 0; frame < fps * duration; frame++) {
  const pixels = Buffer.alloc(width * height * 3), time = frame / fps;
  const box = (x, y, w, h, color) => {
    for (let py = Math.max(0, Math.round(y)); py < Math.min(height, Math.round(y + h)); py++)
      for (let px = Math.max(0, Math.round(x)); px < Math.min(width, Math.round(x + w)); px++) {
        const i = (py * width + px) * 3; pixels[i] = color[0]; pixels[i + 1] = color[1]; pixels[i + 2] = color[2];
      }
  };
  box(0, 0, width, height, [30, 32, 35]);
  box(78, 0, 4, height, [65, 65, 65]);
  for (const [x, lightX] of [[40, 29], [120, 131]]) {
    const y = 210 - Math.min(1, Math.max(0, (time - launch) / 4.8)) * 160;
    box(x - 4, y - 22, 8, 9, [210, 210, 210]); box(x - 3, y - 12, 6, 21, [210, 210, 210]);
    box(x - 12, y - 9, 24, 4, [210, 210, 210]);
    box(x - 9, y + 8, 4, 17, [210, 210, 210]); box(x + 5, y + 8, 4, 17, [210, 210, 210]);
    box(lightX - 5, 247, 10, 10, time < start ? [20, 210, 35] : [20, 35, 220]);
  }
  if (!child.stdin.write(pixels)) await once(child.stdin, "drain");
}
child.stdin.end();
const [code] = await closed;
await rm(audio); await rmdir(temp);
if (code !== 0) throw new Error(errors || `Encoder exited ${code}`);
const probe = spawn(encoder, ["-hide_banner", "-i", file, "-an", "-vf", "showinfo", "-f", "null", "-"], { windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
let info = ""; probe.stderr.on("data", data => info += data);
const [probeCode] = await once(probe, "close");
const points = [...info.matchAll(/\bn:\s*(\d+).*?pts_time:\s*([\d.]+)/g)].map(match => Number(match[2]));
if (probeCode !== 0 || points.length !== fps * duration || points.some((pts, index) => Math.abs(pts - index / fps) > .00001))
  throw new Error("Encoded fixture did not preserve the authored source PTS grid.");
const metadata = { version: 1, synthetic: true, workflowOnly: true, license: "CC0-1.0", width, height, fps, duration,
  sha256: createHash("sha256").update(await readFile(file)).digest("hex"), authoredStart: start, authoredLaunch: launch,
  tones: [{ onset: .4, frequency: 550 }, { onset: .9, frequency: 550 }, { onset: start, frequency: 1100 }],
  referenceMethod: "Original geometric animation and synthesized audio. Authored clocks are workflow controls, not independent human labels or real-climber accuracy evidence.",
  decodedSourcePTS: { frames: points.length, first: points[0], last: points.at(-1), checkedAgainstAuthoredGrid: true, maxToleranceSeconds: .00001 } };
await writeFile(path.join(out, "dual-lane.reference.json"), JSON.stringify(metadata, null, 2) + "\n");
console.log(JSON.stringify({ file, bytes: (await readFile(file)).length, sha256: metadata.sha256, frames: points.length }));
