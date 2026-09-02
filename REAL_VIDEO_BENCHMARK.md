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

## Current measured baseline

The September 2 evaluation reran every clip from a fresh page using the production workflow rather than calling detector helpers directly.

| Measurement | Result |
| --- | --- |
| Videos evaluated | 5 |
| Starts automatically accepted | 2 |
| Known false starts automatically accepted | 0 |
| Starts conservatively sent to review | 3 |
| Accepted-start clips with an automatic High finish | 1/2 |
| Accepted-start clips with a bounded review finish | 1/2 |
| 5 fps complete COM run | 42/52 usable frames (80.8%) |
| Repeated 10 fps COM runs | 43–45/104 usable frames (41.3–43.3%) |
| 15 fps complete COM run | 0/156 usable frames (0%) |
| Automatic Hold 10 contacts on the complete COM run | 0 |
| Review-level Hold 10 height candidates | 1 (11.515 s raw / 4.385 s after start) |

This is a precision-first regression sample, not a population accuracy claim. Five related phone recordings are not enough to estimate general accuracy. The next useful dataset should contain labeled start, Hold 10 contact, and finish frames from different phones, gyms, lanes, lighting conditions, and camera angles.

The complete `IMG_9199.MOV` run exposed the largest remaining data limitation: timing was stable at 7.130 s → 17.480 s across repeated runs, but visual route registration consistently found only 8 of the 10 matches required by policy, so Hold 10 contact could not be accepted automatically. COM tracking changed sharply with sample rate: 5 fps produced 42/52 usable frames (80.8%) and recovered every wall-height split, 10 fps produced only 43–45/104 (41.3–43.3%), and 15 fps failed identity selection. The measured 5 fps setting is now the phone-video default; 10/15 fps remain advanced options.

With the improved 5 fps track, the review-only hand-height fallback found a continuous crossing at 11.515 s raw (4.385 s after Start). Reviewing and accepting that frame in the UI produced 4.385 s Start → Hold 10 and 5.965 s Hold 10 → Finish. The independent 7.5 m COM-height crossing was 4.409 s, 0.024 s later; they remain separately labeled instead of treating that near-agreement as proof of contact. This remains a human-confirmed workflow rather than an automatic contact claim because Hold 10 itself was not visually registered.

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

The browser timing runner executes only the five IDs recorded in the benchmark JSON by default, so extra research clips can safely live in the private video directory. Run one new clip without claiming a baseline using:

```bash
npm run benchmark:timing -- new-race-clip.mp4
```
