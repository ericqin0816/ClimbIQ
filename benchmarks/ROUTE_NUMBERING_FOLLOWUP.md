# Hold numbering and timing follow-up — September 5

## User feedback

The supplied screenshot shows 12.283 s; the user's reference for that run is
12.24 s, a +0.043 s difference. They also identify a displayed 9 as actual Hold 8.
This is recorded in `user-reported-references.json` without inventing a filename,
start timestamp or finish timestamp. The shared Drive folder still contains
the same five cached recordings, and their camera views do not match the
supplied screenshot. The source recording/export has been requested.

Do not subtract 43 ms from all videos or globally relabel Hold 9. Equal errors
in Start and Finish can cancel in a total, and the reference belongs to one run.

## Reproduced assignment defect

The old nearest-pair-first assignment could give Hold 9 the only silhouette
available to Hold 8, even when another valid candidate remained for 9. A small
synthetic regression reproduced this: the old matcher returned one match with
the lower candidate assigned to 9; joint assignment returns both correct pairs.
This is a related failure mechanism, not proof that the supplied screenshot
has the same cause.

Final affine/projective candidate assignment now minimizes total squared
spatial residual with explicit unmatched choices. Out-of-radius candidates
remain forbidden. Unmatched holds cost one radius squared, so the solver does
not maximize label count regardless of fit. Initial transform fitting retains
the existing fast search; calibration, silhouette, lane identity and route
support gates are unchanged. No hold is globally renumbered.

The formulation is a rectangular minimum-cost assignment problem; see the
[SciPy assignment documentation](https://docs.scipy.org/doc/scipy/reference/generated/scipy.optimize.linear_sum_assignment.html)
for the general problem definition. This implementation adds no dependency
on SciPy and its correctness is checked against exhaustive small assignments.

## Verification

- The 8/9 competing-candidate regression passes after failing under greedy
  matching. Missing holds remain unmatched and candidate reordering does not
  change unambiguous identities.
- Eighty seeded small cases agree with exhaustive minimum-cost solutions.
- All five original full workflows pass with accepted Start/Finish unchanged.
  The complete reference still registers 19/20 holds; that is coverage, not
  a statement that all nineteen labels have independent confirmation.
- The browser benchmark now captures displayed hold IDs and normalized marker
  positions. Invalid or duplicate numbers fail the run; a plausible but wrong
  identity still requires independent visual reference to detect.
- Same-media comparison accepts `--tolerance=0.01`, retaining exact reported
  differences while keeping accuracy unavailable when independent labels are
  absent. A 43 ms shift fails the new 10 ms test policy.

## Completed replay

- 513 unit tests in 53 files, TypeScript checks and production build pass.
- All 30 controlled variations of the five source climbs completed with zero
  workflow errors and zero source-timing regressions. Fifteen cases still need
  investigation; passing a safety/regression test is not a correctness label.
- Paired comparison against the prior checksummed 30-copy run at a 10 ms
  threshold has 30 paired cases, zero availability losses, zero new unverified
  acceptances, zero timing drifts and zero changes within policy. Accepted
  timestamps are unchanged, not demonstrated to be more accurate.
- Both known false-finish guards held. The resized and trimmed complete
  reference each retain 19 displayed holds and visually registered Hold 10;
  compressed/dark/low-frame-rate/silent copies still withhold unsupported
  numbering. No source case lost registered Hold 10 in this comparison.
- Final report: `test-results/video-robustness-2026-09-05T19-03-16-628Z.json`.
  Comparison baseline: `video-robustness-2026-09-05T12-12-45-711Z.json`.
  Both are ignored private-workflow artifacts. Source media and frame images
  remain outside Git.
