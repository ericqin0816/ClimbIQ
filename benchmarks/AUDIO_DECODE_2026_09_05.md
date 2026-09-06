# Audio decode memory experiment

Local Chrome, 2026-09-05, same encoded source bytes per pair; default context
actually decoded at 44,100 Hz. Candidate context requests 8,000 Hz, the existing
countdown detector's analysis rate. Both paths run the same first-12-second
resampling and beep-analysis code. These are audio-only suggestions, not fused
Start decisions or independently labeled race starts.

| Source | Default decoded PCM bytes | 8 kHz PCM bytes | Default audio candidate | 8 kHz audio candidate |
| --- | ---: | ---: | --- | --- |
| 12.24.mov | 8,798,840 | 1,596,160 | 9.40 s, High | 9.40 s, High |
| IMG_8903.MOV | 9,438,576 | 1,712,208 | 4.29 s, High | 4.29 s, High |
| IMG_9075.MOV | 10,739,224 | 1,948,160 | 7.23 s, Medium | 7.23 s, Medium |
| IMG_9076.MOV | 11,902,880 | 2,159,248 | 2.79 s, Medium | 2.79 s, Medium |
| IMG_9077.MOV | 9,226,304 | 1,673,704 | 5.25 s, High | 5.25 s, High |
| IMG_9199.MOV | 11,350,744 | 2,059,088 | 4.12 s, Medium | 4.12 s, Medium |
| public-krakow-attempt-0750.mp4 | 8,820,000 | 1,600,000 | 6.49 s, Low | 2.92 s, Low |

All six private audio candidates retained the same time, confidence, and
two-same-then-different pattern. The Krakow regular-countdown suggestion changed;
neither is an authoritative start. Full-workflow rejection safety must be checked
before shipping, and changes to unsupported suggestions must stay visible.

The measured allocation is `AudioBuffer.length * numberOfChannels * 4`, not
browser-process peak memory, decoder scratch memory, or the encoded video buffer.
This is about 5.5 times less decoded PCM, not a 5.5-times-faster application.
Single-trial decoding times were mixed (for example, 37→39 ms on 12.24 and
275→297 ms on IMG_8903); no speed claim is supported.

The Web Audio specification requires `decodeAudioData` to resample to the
context's sample rate:
https://webaudio.github.io/web-audio-api/#dom-baseaudiocontext-decodeaudiodata .
The implementation still needs a default-rate fallback if a browser rejects the
requested rate. It does not provide streaming or bounded-window decoding of
long files. The cached full Chamonix preview has no audio and therefore cannot
reproduce a long-audio allocation problem.

## Candidate verification (0.28.6)

- All six original private full workflows pass with unchanged Start/Finish
  decisions. The user's total-only reference remains 12.255 versus 12.240 s.
- All seven public clips remain review-only; no new automatic timestamps.
- Native browser decoding also passes with the requested 8 kHz context
  deliberately rejected: real default-rate fallback preserves the two private
  cases and Krakow rejection safety. The test records both attempted rates.
- Twelve decoder lifecycle unit cases cover constructor failures, file-read
  failures, unsupported rate fallback, codec rejection and cancellation cleanup.
- `npm run test:audio-browser` exercises real WAV decoding at 8, 44.1 and 48 kHz,
  stereo mixing, absolute search offsets, out-of-band alias traps, same-pitch
  non-official tones, silence and invalid codec input. All eight scenarios pass.
  Clean synthetic beeps starting at exactly 4.000 s are suggested at 3.990 s;
  this exposes the existing overlapping-window quantization, not millisecond
  event accuracy. No fixed offset was added to force a real-video total.
- Start/finish/pose cancellation and source replacement pass in Chrome.

The 36-case full-workflow transformed-source comparison is complete: 0 workflow
errors, 0 acceptance gains/losses, and **no changed accepted Start/Finish times**
between 0.28.5 and 0.28.6. This uses identical checksummed media and a stricter
10 ms comparison policy; it establishes output stability, not general accuracy.
Both runs retain 21 cases needing investigation under the existing label policy.
Reports: `test-results/video-robustness-2026-09-05T23-56-16-041Z.json` and
`test-results/video-robustness-2026-09-06T00-22-02-829Z.json`.

An eighth public clip, Emma Hunt's four-lane record highlight, also passes
full-workflow rejection safety. Its post-finish audio false cue is registered as
a negative fingerprint; the launch guard prevents automatic acceptance. Neither
that safe refusal nor any other public refusal is a correctly timed race.

Status: verified checkpoint 0.28.6; publication verification recorded in the
two-hour work log.
