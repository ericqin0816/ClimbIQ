# Evidence-review checkpoint

This feature adds a review layer; detector thresholds, video measurements and
contact acceptance are unchanged. It does not establish coaching efficacy.

## Local checks

- Full checks: typecheck (including server/API/Vite config), unit suite and build.
- A standalone compiled-Node smoke test checks the emitted API with Node's ESM
  resolver. The first hosted status probe failed despite a successful Vite build;
  extensionless server imports were reproduced as a Node module-resolution error
  and replaced with explicit `.js` paths. This runtime check is now part of CI.
- New tests cover evidence provenance, privacy, comparison floors, strict model
  output selection, disabled configuration, workspace auth, input/origin/size
  checks, reservation-before-inference, save-before-response, deduplication,
  budget refusal, persistence/provider failures, and authenticated readback.
- Redis REST command tests check the atomic reservation command and namespacing.
  They are mocked contract tests, not a live Redis concurrency/load test.
- The actual NIM-compatible SDK adapter runs against mocked HTTP responses;
  URL, bearer header, model, token cap, usage and rejected output are asserted.
- Browser contract test: accepted numeric facts, unreviewed Hold 10 gate, source
  jump, opt-in gate, mandatory limitations, no private metadata in API packet,
  saved readback without video links, stale-response rejection, desktop/mobile.
- Manual browser smoke: original video upload and missing-start review; saved
  review link opens without requiring a video; no browser exceptions observed.

## Original-video regressions

Full local workflows (including save/reload and existing review checks) passed
for both originals after introducing the panel and server integration:

| Original | Start | Finish | Total |
| --- | ---: | ---: | ---: |
| User-referenced 12.24 run | 9.400s | 21.655s | 12.255s |
| Second baseline run | 7.121s | 17.472s | 10.351s |

The first total is 15ms above the user's 12.240s reference. That is a total-only
comparison, not endpoint ground truth or a general accuracy bound. All detailed
reports and private screenshots remain ignored under `test-results/`.

## Not verified / not enabled

No NVIDIA key, hosted model entitlement, live Redis credentials, or account-level
pricing was available. No live inference or cloud database was provisioned.
Hosted review remains disabled until the owner configures it. The shared-code
workspace is for private demos, not public multi-user use. Follow
[the configuration and privacy notes](../docs/coaching.md) before enabling it.
