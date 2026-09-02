# Real-video benchmark

This benchmark records behavior on five private 1080 × 1920 phone recordings. The source videos stay outside the repository and are processed locally.

## What the clips exposed

- Angled cameras can separate the apparent bottom-sensor and top-indicator x positions.
- A valid-looking beep/light event can occur after an athlete is already climbing.
- Ropes, hair, faces close to the phone, scoreboards, and post-climb timing resets can resemble finish evidence.
- A missing finish must not make pose analysis include setup footage or descent.

## Regression results

| Clip | Previous behavior | Current behavior |
| --- | --- | --- |
| `IMG_8903.MOV` | Plausible start, but no finish | Start launch confirmed; upper-wall fallback recovers a finish candidate around a 10.0 s climb |
| `IMG_9075.MOV` | Incorrect 14.900 s start was automatically accepted mid-climb | Start is blocked for review; with a reviewed 8.900 s start, ambiguous upper evidence remains review-only rather than becoming an accepted time |
| `IMG_9076.MOV` | 24.820 s post-climb frame suggested as start | Remains safely review-only |
| `IMG_9077.MOV` | Incorrect 5.250 s start was automatically accepted while athletes were already underway | Start is blocked for review |
| `IMG_9199.MOV` | Plausible 7.130 s start and 10.350 s total | Valid result remains stable; existing lane-light finish path still wins |

## Acceptance policy

Automatic timestamps are intentionally precision-first:

1. Start light/audio evidence defines the exact clock only after lane-local motion confirms a new launch.
2. The original start-verified lower lane remains the athlete-identity anchor.
3. Lower-sensor finish evidence is preferred when it is strong.
4. Upper electronic evidence is accepted only with physical-top or official-time corroboration.
5. Physical-only and ambiguous results are surfaced for exact-frame review.
6. Pose analysis pauses when there is no usable finish boundary, preventing setup/descent contamination.

## Automated coverage

The test suite includes tiny upper indicators, exposure changes, transient and full-frame occlusions, frame-level transition refinement, physical top reach/descent, missing descent, and automatic-start body-audit cases. Run it with `npm test`.
