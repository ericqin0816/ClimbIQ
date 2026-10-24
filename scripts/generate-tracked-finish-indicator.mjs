// SPDX-License-Identifier: CC0-1.0
// Original graphics/audio for a moving-camera review workflow, not field accuracy.
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
const option = key => process.argv.find(arg => arg.startsWith(`--${key}=`))?.slice(key.length + 3);
const dir = path.resolve(option('output-dir') ?? 'e2e/fixtures');
const variant = option('variant') ?? 'pan';
if (!['pan', 'no-event', 'cut', 'occlusion', 'ambiguous'].includes(variant))
    throw new Error('Unknown authored tracking variant');
const plan = { variants: [{ id: variant }], camera: { atAnchor7: [80, 50],
        motion: 'originX=80+clamp((t-7)*24,-30,30); originY=50+clamp((t-7)*12,-20,20), integerrounded',
        maximumOrdinaryAdjacentShiftPixels: 1, referenceAnchorCursor: 7 }, sourceHueShadow: { from: 6.8, to: 7, brightness: .55 } };
// Provenance of the initial authored experiment; no private inputs are needed.
const initialResearchPlanSha256 = '73df4407070960ff16b409aab4d24bc7559912d0dc7e106dea325e261e6a1708';
const encoder = process.env.CLIMBIQ_FFMPEG ?? 'ffmpeg';
const width = 320, height = 180, fps = 30, duration = 10, worldWidth = 640, worldHeight = 360;
await mkdir(dir, { recursive: true });
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const before = [40, 180, 80], after = [190, 50, 45];
function worldTexture(variant) {
    const pixels = Buffer.alloc(worldWidth * worldHeight * 3);
    let state = 173;
    for (let y = 0; y < worldHeight; y += 4)
        for (let x = 0; x < worldWidth; x += 4) {
            state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
            const value = variant === 'ambiguous' ? ((x / 4 + y / 4) % 2 ? 190 : 45) : 35 + state % 185;
            for (let py = y; py < y + 4; py++)
                for (let px = x; px < x + 4; px++)
                    pixels.fill(value, (py * worldWidth + px) * 3, (py * worldWidth + px) * 3 + 3);
        }
    return pixels;
}
function camera(time, variant) {
    return { x: Math.round(80 + Math.max(-30, Math.min(30, (time - 7) * 24)) + (variant === 'cut' && time >= 6.9 ? 70 : 0)),
        y: Math.round(50 + Math.max(-20, Math.min(20, (time - 7) * 12)) + (variant === 'cut' && time >= 6.9 ? 35 : 0)) };
}
for (const variant of plan.variants.map(item => item.id)) {
    const stem = 'tracked-finish-' + variant, file = path.join(dir, stem + '.mp4');
    for (const output of [file, path.join(dir, stem + '.reference.json')]) {
        try {
            await access(output);
            throw new Error('Fixture output already exists; choose a new --output-dir: ' + output);
        }
        catch (error) {
            if (error.code !== 'ENOENT')
                throw error;
        }
    }
    const audio = '0.34*sin(2*PI*550*t)*between(t,0.4,0.54)+0.34*sin(2*PI*550*t)*between(t,1.4,1.54)+0.34*sin(2*PI*1100*t)*between(t,2.4,2.54)';
    const args = ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'rawvideo', '-pixel_format', 'rgb24', '-video_size', `${width}x${height}`, '-framerate', String(fps), '-i', 'pipe:0',
        '-f', 'lavfi', '-i', `aevalsrc=${audio.replaceAll(',', '\\,')}:s=24000:d=${duration}`, '-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '64k', '-t', String(duration), '-movflags', '+faststart', file];
    const child = spawn(encoder, args, { windowsHide: true, stdio: ['pipe', 'ignore', 'pipe'] });
    let errors = '';
    child.stderr.on('data', bytes => errors += bytes);
    child.stdin.on('error', () => { });
    const done = once(child, 'close');
    const world = worldTexture(variant);
    for (let index = 0; index < fps * duration; index++) {
        const time = index / fps, cam = camera(time, variant), pixels = Buffer.alloc(width * height * 3);
        for (let y = 0; y < height; y++)
            for (let x = 0; x < width; x++) {
                const source = ((y + cam.y) * worldWidth + x + cam.x) * 3, target = (y * width + x) * 3;
                pixels[target] = world[source];
                pixels[target + 1] = world[source + 1];
                pixels[target + 2] = world[source + 2];
            }
        const box = (wx, wy, w, h, color) => {
            const x = wx - cam.x, y = wy - cam.y;
            for (let py = Math.max(0, y); py < Math.min(height, y + h); py++)
                for (let px = Math.max(0, x); px < Math.min(width, x + w); px++) {
                    const p = (py * width + px) * 3;
                    pixels[p] = color[0];
                    pixels[p + 1] = color[1];
                    pixels[p + 2] = color[2];
                }
        };
        box(152, 142, 12, 10, time < 6.25 ? before : after);
        const selected = variant === 'no-event' ? before : time >= 7 ? after : time >= 6.8 ? before.map(v => Math.round(v * .55)) : before;
        box(316, 142, 12, 10, selected);
        if (variant === 'occlusion' && time >= 7.15)
            box(256, 92, 132, 110, [80, 80, 80]);
        if (!child.stdin.write(pixels))
            await once(child.stdin, 'drain');
    }
    child.stdin.end();
    const [code] = await done;
    if (code !== 0)
        throw new Error(errors || 'Encoder failed');
    const probe = spawn(encoder, ['-hide_banner', '-i', file, '-an', '-vf', 'showinfo', '-f', 'null', '-'], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    let info = '';
    probe.stderr.on('data', bytes => info += bytes);
    const [probeCode] = await once(probe, 'close');
    const pts = [...info.matchAll(/\bn:\s*(\d+).*?pts_time:\s*([\d.]+)/g)].map(match => Number(match[2]));
    if (probeCode !== 0 || pts.length !== 300 || pts.some((value, index) => Math.abs(value - index / fps) > .00001))
        throw new Error('Source PTS grid changed');
    const cam = camera(7, variant), rect = [316 - cam.x, 142 - cam.y, 328 - cam.x, 152 - cam.y];
    const metadata = { schemaVersion: 1, synthetic: true, workflowOnly: true, license: 'CC0-1.0', variant, width, height, fps, duration,
        sha256: hash(await readFile(file)), authoredStart: 2.4, authoredIndicatorTransition: variant === 'no-event' ? null : 7, authoredOtherLaneTransition: 6.25,
        anchorCursor: 7, expectedAnchorNativePts: 7, anchorIndicatorPixelRect: rect,
        anchorIndicatorRegion: { id: 'finishIndicator', label: 'Authored selected right indicator', x1: rect[0] / width, y1: rect[1] / height, x2: rect[2] / width, y2: rect[3] / height },
        camera: plan.camera, sourceHueShadow: variant === 'no-event' ? null : plan.sourceHueShadow,
        decodedSourcePts: { count: pts.length, first: pts[0], last: pts.at(-1), verified: true },
        referenceMethod: 'Original authored RGB pixels, camera translation and sine audio. No real climber, pad contact, calibrated sensor timing or independent human annotation.',
        planSha256: initialResearchPlanSha256 };
    await writeFile(path.join(dir, stem + '.reference.json'), JSON.stringify(metadata, null, 2) + '\n', { flag: 'wx' });
    console.log(JSON.stringify({ variant, file, sha256: metadata.sha256, bytes: (await readFile(file)).length }));
}
