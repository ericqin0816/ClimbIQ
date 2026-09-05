# Controlled video robustness tests

These are altered copies of existing recordings, not additional independent
climbs or new human labels. They test whether analysis changes when the event
itself does not. The 0.100 s tolerance is a regression policy, not an accuracy
bound, confidence interval, or competition-timing certification.

## Run locally

Start the app, then run:

```sh
npm run dev
npm run benchmark:robustness -- IMG_9199.MOV IMG_8903.MOV
```

The runner needs local Google Chrome and FFmpeg. Set `CLIMBIQ_FFMPEG` to an
FFmpeg executable if it is not on PATH on macOS/Linux or in the existing ignored
ClimbIQ tools directory on Windows. `CLIMBIQ_VIDEO_DIR`, `CLIMBIQ_CHROME`, and
`CLIMBIQ_E2E_URL` override source media, Chrome, and the test app URL.

Useful subsets:

```sh
npm run benchmark:robustness -- --generate-only IMG_9199.MOV
npm run benchmark:robustness -- --variants=dark-720,compact-360 IMG_8903.MOV
npm run benchmark:robustness -- --full --variants=control-720 IMG_9199.MOV
```

Run one browser benchmark at a time: the existing timing runner uses port 9334.

## Test variations

| Variation | Change | Known timing transform |
| --- | --- | --- |
| control-720 | 720-pixel-wide H.264, CRF 18 | None |
| compact-360 | 360-pixel-wide H.264, CRF 32 | None |
| dark-720 | 720 wide, brightness -0.035, gamma 0.65 | None |
| low-fps-720 | 720 wide, 15 video frames/s | None; greater frame quantization |
| silent-720 | 720 wide, audio removed | None; less evidence available |
| trim-2s-720 | 720 wide, first two seconds removed | Subtract 2 s from event times |

All copies explicitly select the primary video and optional first audio stream,
strip camera/location metadata, and remain under ignored `node_modules/`.
Checksummed sidecars record source identity and transform parameters. The runner
refuses to silently reuse changed or unprovenanced copies. Timestamped reports
are saved incrementally in ignored `test-results/`, including per-case failures.

## Interpret outcomes

Compare two completed runs on identical checksummed media:

```sh
npm run benchmark:compare -- test-results/BEFORE.json test-results/AFTER.json
```

This separates changes between app versions from differences between an original
and a transformed copy. Different/missing media, unfinished reports, duplicate
cases, and workflow errors cannot silently count as successful pairs. Coverage
is compared only at the same pose sampling rate and full-workflow mode. Exit 1
means unpaired cases or output timing drift; exit 2 means newly accepted timing
without independent verification, which needs inspection. Neither matching
outputs nor increased acceptance is proof of better accuracy.

Interruption/replacement checks are available separately with
`npm run test:cancellation` and the same `CLIMBIQ_VIDEO_DIR` / `CLIMBIQ_E2E_URL`
settings. They require original 9199 and 9076, cancel three analysis stages,
and verify cursor restoration, marker preservation, busy-state replacement
blocking, rapid replacement, and invalid-file recovery.

- **Consistent:** accepted boundary agrees with a reviewed original reference.
- **Availability loss:** an originally accepted boundary is now missing/reviewed.
  This is a usability regression, not a wrong automatic measurement.
- **Timing regression:** accepted boundary disagrees with a reviewed reference.
- **Unverified acceptance:** automatic acceptance has no independent label to
  establish correctness; matching an old review suggestion does not verify it.
- **New labeled acceptance:** a previously reviewed boundary becomes accepted and
  agrees with its independently reviewed timestamp.

Each boundary also reports `sourceConsistency`: matching an accepted source
observation is useful even when its absolute accuracy remains unverified. A
`source-timing-regression` flags transformed output drift without claiming the
source was ground truth. Legacy correctness booleans and unexplained manual
times never qualify as independent labels. Reports include their reference
snapshot so later label revisions cannot silently change the interpretation.

Both boundary shifts and total-duration shifts are reported. A correct total
alone can hide equal errors in Start and Finish. Nonzero exit status signals a
workflow error, source-timing drift, or disagreement with an independent label; inspect availability losses and
unverified acceptances even when the runner exits successfully.
Review suggestions are also compared when a separately reviewed reference
exists. An inaccurate suggestion is flagged for investigation but not counted as
a wrong automatic acceptance.

## First failure found (September 5)

Darkening `IMG_8903.MOV` produced an accepted Finish at 9.290 s while the athlete
was still climbing. A red-dominant obstruction passed the green-minus-blue
test, and failed dense refinement left the coarse result at High confidence.
The patch adds a normalized red-channel plausibility check and makes
unconfirmed coarse results review-only. Original five-video full workflows
continue to pass. Broader and post-patch measurements belong in the work log;
these two source climbs are far too few for general accuracy claims.

The twelve-copy post-patch run had no disagreements with its then-current
references and no workflow errors. Five altered angled copies still needed
start review. The dark copy now withholds Finish, but its upper review cursor
is 18.290 s. A subsequent direct frame audit disputes the old 14.290 s reference
itself, so neither the original “five seconds early” score nor a “four seconds
late” score is valid ground-truth error. Both physical-top cursors remain
unverified. Exact contact annotation is still pending.
