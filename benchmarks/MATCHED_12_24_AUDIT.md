# Matching 12.24-second recording — September 5, 2026

## Source and reference

The user supplied `12.24.mov` after the five original Drive clips had been
tested. It is a sixth independent source recording, not another labeled variant
of one of the five. SHA256:
`b981cc57f8d3d4fe9c57e4e6414f23457ad8bc7eb7cbec5a95c969707d21b333`.
The private copy is 6,060,680 bytes, 480×854, approximately 29 fps and 24.97 s.
No video or frame images are committed.

The user's **12.24 s total** and **9 should be 8** correction are recorded in
`user-reported-references.json`. They do not independently label either raw
Start or Finish. A checksum mismatch fails the user-reference check; a missing
or misplaced Hold 8 fails a full-workflow replay. Total error is reported, not
misrepresented as proof of general accuracy.

## Exact reproduction and change

| Measurement | 0.28.2 reproduction | 0.28.3 |
|---|---:|---:|
| Accepted Start | 9.400 s | 9.400 s |
| Accepted Finish | 21.683 s | 21.655 s |
| Total | 12.283 s | 12.255 s |
| Error against user total | +0.043 s | +0.015 s |
| Visible route matches | 11 | 18 |
| Label near image (0.32986, 0.34820) | 9 | 8 |

### Route numbering

The previous policy accepted an 11-point legacy-diagram fit, including a
separately recovered Hold 10, without evaluating the attachment-grid fallback.
The grid search was also selecting a low-support accident ahead of a supported
route because the accident was closer to the body-region center.

Selection now considers supported hypotheses before rejecting the search. Weak
legacy fits can trigger grid recovery. A broad or edge-clipped body zone is an
interval, not an exact hand location; its half-width is included in the final
anchor check. Center distance still ranks competing lanes, and nearly equally
supported routes with indistinguishable anchors are refused. Recovery still
requires at least 16 direct silhouette matches, direct 9/10/11 support, and tight
median/RMS residuals. It does not change wall calibration or COM measurements.

The exact clip's seven-frame replay improved median fit residual from 1.24% to
0.31% of normalized image coordinates. This is fit quality, not a ground-truth
count of eighteen correct identities. Holds 4 and 15 remain unregistered.

### Finish frame timing

The first return-color source frame has PTS **21.655 s**. The old 30 fps scan
requested **21.683 s**, decoded that earlier frame, and incorrectly stamped the
pixels with the seek cursor. The preceding source frame at 21.620 s still has
the during-climb color. Dense source-frame audit recovers the same 21.655 s
flash using the existing color/persistence detector.

Finish sampling now reads native decoded frame PTS, retaining seek time as a
fallback when the browser cannot expose it. Repeated/older decoded frames are
not counted as additional persistent evidence. There is no filename-specific
timing adjustment and no change to the audio-defined Start.

The residual 15 ms is smaller than this clip's approximately 34.5 ms frame
period. It may include frame quantization and audio/light/camera timing, but
this audit does not establish those individual contributions. It would be
incorrect to force 12.240 by shifting Start or Finish from the total alone.

## Verification

- 523 unit tests in 54 files, TypeScript checks, and production build pass.
- Exact-video full workflow reproduces 12.255 s and corrected Hold 8 with 18
  registered markers; 46/62 usable COM samples. Save/reload, comparison and
  manual-review workflow pass. Manual acceptance fixtures are not labels.
- All six source workflows pass. Report:
  `test-results/six-originals-0.28.3.json`.
- `IMG_9199.MOV` retains 19 route markers and 45/52 usable COM samples; Start
  remains 7.130 s and native-PTS Finish is 17.472 s (previously 17.480 s).
  The other four original clips retain their acceptance/review behavior:
  8903 accepts Start 4.290 s but withholds Finish; 9075, 9076 and 9077 still
  require Start review at 8.450, 2.790 and 5.250 s respectively.
- Six controlled copies of the new source complete with no workflow errors or
  source-timing regressions under the existing 100 ms metamorphic policy.
  These are not six independent recordings or new boundary labels; all six
  assessments retain `needsInvestigation` because independent labels are absent
  and some lose availability. Report:
  `test-results/video-robustness-2026-09-05T19-38-38-635Z.json`.

| New-source variation | Automatic total | Route markers | Limitation |
|---|---:|---:|---|
| 720p control | 12.255 s | 18 | COM 33/62 usable |
| Compressed 360p | unavailable | 0 | Start requires review |
| Darkened | unavailable | 0 | Finish unavailable |
| 15 fps | 12.267 s | 0 | Route registration withheld |
| No audio | unavailable | 0 | Start requires review |
| Trim first 2 s | 12.255 s | 18 | Raw times shift by exactly 2 s |

Desktop and 390 px mobile overlays were inspected and display the corrected
8/9 ordering. No page errors were reported by the browser check. Those local
screenshots include the user's existing, uncommitted stylesheet edits; this
task does not alter or publish those unrelated edits.

Both checksummed known-false-finish replays still withhold automatic Finish:
the darkened 8903 obstruction at 9.290 s and the silent 9076 spectator/reset at
29.717 s. The latter remains a review suggestion, not an accepted result.
Report: `test-results/false-finish-guards-0.28.3.json`.

With `VideoFrame` deliberately disabled, the full workflow still passes and
Hold 8 remains corrected, but timing correctly falls back to the old 12.283 s
estimate. The 28 ms improvement is therefore verified for native-frame-capable
Chrome, not claimed for every browser. Report:
`test-results/no-native-frame-0.28.3.json`.
