# Finish detection follow-up — October 24, 2026

The follow-up found and reproduced a lower lane-light detector bug: adding a longer tail to an
otherwise identical recording could change the inferred lamp state. In an
authored native-video control, the released detector selected an 8.000 s reset
as High-confidence Finish instead of the first reversal at 4.000 s. Without the
reset, it missed that first reversal altogether.

Production lower-lane detection now compares a fixed history before the eligible
Finish search with the state inferred by the original scan. Agreeing or
inconclusive history preserves the released behavior. Conflicting states produce
review suggestions, never a newly authoritative clock. Refinement compares dense
observations; a competing coarse time cannot outrank a valid dense result and
remains explicitly labeled unrefined.

The long-tail control now suggests 4.000 s for review, preserving the 8.000 s
alternative without automatically accepting it. This corrects a demonstrated
failure; it does not establish better field accuracy or increased automatic
coverage.

## Verification

- All 1,238 unit cases pass, including the existing expected-failure controls.
  TypeScript and the production build pass.
- Seven native Chrome decoding/seek contract checks pass. Six primary times
  match the authored reversal; the seventh deliberately retains an incorrect
  review cursor with the correct alternative. These videos contain no real
  climbers or physical pad-contact measurements.
- Independent review replays the same 189 authored inputs: two additional
  first-observed event cursors are recovered, with no loss of an old correct
  cursor or newly eligible High clock. Some coarse samples are 150 ms after the
  physical change. These counts are not a field-accuracy or 100 ms error result.
- Fresh baseline and candidate runs both complete all six existing original
  phone recordings. Both accept exactly the same four of twelve endpoints,
  producing one complete pair; every accepted timestamp matches. All 43 served
  assets are bound before and after each run, and the candidate's 219 source/test
  file hashes are retained. This remains a development cohort with unverified
  endpoint correctness. The paired candidate run uses a frozen pre-commit
  production build; CI rebuilds the committed source.
- `npm run test:finish-baseline` reproduces the native controls against a local
  Vite server. Set `CLIMBIQ_FFMPEG` when needed. CI is configured to run Chrome
  and Mac/WebKit checks and retain JSON failure evidence. Local Windows WebKit cannot decode the
  authored H.264 file; that failure is retained separately from Mac or iPhone
  results.

## Rejected changes and remaining failures

Independent focused patch readiness is **8.7/10** (weighted 8.725), up from the
stricter successor's 8.4/10. This measures code readiness; it is not a detection
accuracy score. Remote CI and clean release verification remain separate gates.

The first proposed Finish fix passed the simple native controls but failed
independent obstruction challenges. It was rejected before release.

A stricter successor introduced exposure-related abstentions and incorrect
review suggestions. Feedback from the same independent controls led to the
narrower polarity-only policy; its normal and unsupported-history paths preserve
the original analysis instead of substituting different brightness statistics.

A separate audio experiment recovered four previously missed authored positives,
but independent testing found 34 new High-confidence outputs among 74 authored
negatives: an already-present upper tone could masquerade as a new final beep.
That change remains outside production. Its cases are correlated signal controls,
not independent climbing attempts.

The final Finish policy still has limits. Inconclusive history retains the
released behavior, including its existing false clocks. The 189 authored inputs
still include 22 incorrect High outputs inherited from that policy; these are
not independent field attempts. A same-colored object covering the entire
history can still produce an incorrect review suggestion;
the retained native control suggests 3.600 s while the authored event is 6.000 s.
The 6.000 s alternative remains available, and neither is automatically accepted.
Earlier color history alone cannot establish emitter identity.

Real endpoint-error and false-acceptance rates, correction time, and actual
iPhone behavior remain unmeasured. The previous nine-hour report and twenty-check
ledger remain unchanged. The accompanying
[follow-up measurements](../benchmarks/detection-followup-2026-10-24.json) keep
these narrower findings separate from field accuracy.

## Public dataset eligibility check

The source review found useful candidates for different tasks:

| Primary source | Documented labels | Relevance to this work |
| --- | --- | --- |
| [SPEED21](https://www.muni.cz/en/research/publications/1808457) | Pre-segmented 2D skeleton sequences for 362 performances | Motion analysis; the publication does not supply this app's physical Start/Finish reference protocol |
| [The Way Up](https://zenodo.org/records/15196867) | 22 videos with hold locations, usage order, usage times and occlusion | Potential hold-contact evaluation; different from an electronic Start or Finish indicator |
| [ClimbingCap / AscendMotion](https://arxiv.org/abs/2503.21268) | Multimodal climbing motion and reconstructed pose | Potential pose evaluation; not validation of this phone-video timing pipeline |

These task-compatibility judgments are inferences from the primary descriptions.
No dataset or experimental weights were downloaded or trained during this pass.
Access terms, exact annotation clocks and compatible source files still need
verification before using them in a benchmark. Their published model results
are not ClimbIQ results.
