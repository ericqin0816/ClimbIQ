import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import ts from "typescript";

// Local, explicitly supplied native-PCM observations. Never copy footage/PCM
// into the repository or turn transformed copies into distinct field attempts.
const option = name => process.argv.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
const manifestPath = option("manifest"), output = option("output"), profile = option("profile");
if (!manifestPath || !output || !["gain", "phase", "noise", "rate", "conflict"].includes(profile)) {
  throw new Error("Use --manifest=<native PCM observations.json> --output=<new report.json> --profile=gain|phase|noise|rate|conflict");
}
const source = await readFile("src/lib/detectAudioStartSignal.ts", "utf8");
const code = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
const detector = await import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`);
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const report = { schemaVersion: 1, profile, detectorSha256: hash(source.replace(/\r\n/g, "\n")),
  interpretation: "Audio-kernel stress diagnostics on existing development PCM and authored negative controls. High audio is not whole-app acceptance. Transformations are not distinct attempts, and nominal windows are not accuracy bounds.",
  cases: [] };
const referenceSourceSha256 = "12a1189c069d832b6bcb1f38176786a7abd0cbb88da234bc9c0d1e53881602e5";
function noise(length, seed) {
  const result = new Float32Array(length);
  let state = seed;
  for (let i = 0; i < length; i++) { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; result[i] = state / 2147483648 - 1; }
  return result;
}
function tones(pitches = [550, 550, 1100], offset = 0) {
  const pcm = new Float32Array(5 * 8000);
  pitches.forEach((pitch, beep) => {
    for (let i = 0; i < 1280; i++) {
      const index = Math.round((.8 + beep + offset) * 8000) + i;
      if (index < pcm.length) pcm[index] = .6 * Math.sin(2 * Math.PI * pitch * i / 8000) * Math.min(1, i / 40, (1280 - i) / 40);
    }
  }); return pcm;
}
const variants = {
  gain: [0.1, 0.25, 0.5, 1, 2].map(gain => ({ label: `gain-${gain}`, transform: channels => channels.map(c => c.map(x => Math.max(-1, Math.min(1, x * gain)))) })),
  phase: [1, 0.5, 0, -0.5, -1].map(rightGain => ({ label: `right-gain-${rightGain}`, transform: channels => [channels[0], channels[1].map(x => x * rightGain)] })),
  noise: [.005, .02, .05].map(amplitude => ({ label: `independent-uniform-noise-${amplitude}`, transform: channels => channels.map((c, channel) => { const n = noise(c.length, 4242 + channel); return c.map((x, i) => x + amplitude * n[i]); }) })),
  rate: [8000, 16000, 44100, 48000].map(rate => ({ label: `linear-resample-${rate}`, rate, transform: channels => channels.map(c => Float32Array.from({ length: Math.floor(c.length * rate / 8000) }, (_, i) => { const x = i * 8000 / rate, a = Math.floor(x), f = x - a; return c[a] * (1-f) + c[Math.min(c.length-1,a+1)] * f; })) })),
};
if (profile !== "conflict") {
  for (const clip of manifest.cases) {
    if (clip.metadata?.sampleRate !== 8000 || clip.metadata.timeOffset !== 0 || clip.metadata.windowStartFrame !== 0) {
      throw new Error("Stress inputs require verified 8 kHz PCM starting at source time zero");
    }
    const channels = [];
    for (const observation of clip.outcomes.filter(item => item.kind.startsWith("channel-"))) {
      const bytes = await readFile(path.resolve(path.dirname(manifestPath), observation.pcm.path));
      if (hash(bytes) !== observation.pcm.sha256) throw new Error("Frozen PCM hash changed");
      channels.push(new Float32Array(new Uint8Array(bytes).buffer));
    }
    if (channels.length !== 2) throw new Error("This stress manifest requires original stereo PCM");
    for (const variant of variants[profile]) {
      const input = variant.transform(channels), rate = variant.rate ?? 8000;
      const result = await detector.analyzeAudioChannelWindow(input, rate, 0, input[0].length, 0);
      const difference = clip.sourceSha256 === referenceSourceSha256 && result.rawTime !== undefined ? [result.rawTime - 8.625, result.rawTime - 8.58] : null;
      report.cases.push({ id: clip.id, sourceSha256: clip.sourceSha256, variant: variant.label, sourceSampleRate: rate,
        audioConfidence: result.confidence, rawTime: result.rawTime ?? null, stereoRecovered: Boolean(result.channelRecovery),
        recordedCueDifferenceIntervalSeconds: difference,
        interpretation: difference ? "Targeted development recorded-cue bracket only; transformed clock axis preserved by construction, not a native re-encode/A-V qualification." : "No independent event label for this case; clock/coverage diagnostics only." });
    }
  }
} else {
  const quiet = new Float32Array(40000), wrong = tones([550,700,1100]);
  const controls = [
    ["silence", [quiet, quiet], false], ["seeded-noise", [noise(40000, 42), noise(40000, 81)], false],
    ["equal-pitch-not-official", [tones([550,550,550]), tones([550,550,550])], false],
    ["wrong-preparation-pitches", [wrong, wrong], false],
    ["one-qualified-channel-cancelled-preparations", [tones(), tones().map((x,i) => i < 2.8*8000 ? -x : 0)], false],
    ["cancelled-valid-control", [tones(), tones().map(x => -x)], true],
    ["two-displaced-protocols", [tones(), tones([550,550,1100], .3)], null],
  ];
  for (const [id, channels, expectedHigh] of controls) {
    const result = await detector.analyzeAudioChannelWindow(channels, 8000, 0, channels[0].length, 0);
    report.cases.push({ id, synthetic: true, confidence: result.confidence, rawTime: result.rawTime ?? null, expectedHigh,
      controlPassed: expectedHigh === null ? null : (result.confidence === "High") === expectedHigh,
      interpretation: expectedHigh === null ? "Ambiguous two-source diagnostic, no uniquely labelled event." : "Authored protocol control, not real-climber accuracy." });
  }
}
await writeFile(output, JSON.stringify(report, null, 2) + "\n", { flag: "wx" });
console.log(JSON.stringify({ profile, cases: report.cases.length, high: report.cases.filter(c => (c.audioConfidence ?? c.confidence) === "High").length,
  failedControls: report.cases.filter(c => c.controlPassed === false).map(c => c.id), output }));
