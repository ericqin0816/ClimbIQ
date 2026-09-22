# Evidence review and NVIDIA NIM

The Coaching review panel is an experimental review assistant, not a validated
technique coach. It does not change Start, Finish, Hold 10, or pose results.

## What works without a server

Open a current or saved attempt and choose **Review my run**. No internet
connection, provider key, or AI account is needed for the local review. Saved
measurements can be reviewed without reattaching the video; frame links appear
only when the matching recording is available.

The review starts with a canonical timing summary. With a comparable baseline,
it shows accepted Start → Finish and, when both contact markers were frame
reviewed, Start → Hold 10 and Hold 10 → Finish. The local priorities lead with
the total difference and the largest supported section change. Opposing section
changes are explained together even when the total is unchanged. The phases
partition the run; first movement and wall-height splits must not be added to
them. These are measured interval changes, not explanations of their cause.

The baseline picker includes dates and accepted total times. The current attempt,
known annotation copies of that attempt, and attempts without usable Start/Finish
timing are unavailable as baselines. New saved attempts carry a local
`attemptLineageId`; duplicates retain it through saves and exports. Correcting a
marker or renaming a video does not turn an annotation copy into a new climbing
attempt. A genuinely new attempt receives a new lineage.

For older records, matching file names, duration, and dimensions with overlapping
accepted Start/Finish intervals indicate a possible duplicate. These metadata
cannot identify a file, so the app requires a separate confirmation that the
records describe distinct climbing attempts. It does not hard-block independent
files with coincident metadata. Disjoint intervals in a long recording remain
eligible when they are not known copies of one attempt. The user still confirms
the same climber, route, and comparable recording conditions. No baseline is
selected automatically in coaching. The saved-attempt comparison table retains
diagnostic interval values for known copies but withholds performance-gain labels.

The result is labeled **Local evidence review · rule based**. **What the
measurements show** is separate from **Checks still needed**. Unreviewed contact,
incomplete movement evidence, and tracking gaps become review tasks rather than
technique findings. All required checks and limitations remain available even
when AI chooses a different focus. Small differences within the conservative
comparison rule stay unclassified; this rule is not a measured accuracy bound.

Links seek the current video without accepting or changing markers. Changing
analysis evidence resets the review. Before seeking or accepting a hosted reply,
a local fingerprint also checks source identity, raw timing, tracking, and the
selected baseline. Moving every raw timestamp by the same amount leaves the
numeric intervals unchanged, but still invalidates old video links. This local
fingerprint includes private source details and never enters the hosted packet.

## What NIM adds

NVIDIA NIM selects up to three observations and one next review focus from an
approved catalog. The headline, comparison table, and outstanding review tasks
are always derived locally and cannot be omitted by the model. The browser renders canonical text, never model-written timing,
diagnoses, causes, or training prescriptions. All evidence limitations remain
visible regardless of the model selection. This is AI prioritization, not free-form
coaching or direct video understanding. Catalog policy version 3 participates in
the server deduplication fingerprint. New numeric packets use version 2 and keep
separate total, bottom-phase, and top-phase comparison floors. Each floor comes
from that interval's endpoints. Coarse Hold 10 evidence can withhold a small
phase change without hiding a total-time change supported by Start and Finish.

Version 1 packets and archived records remain supported. Their original wire
shape and version are preserved in storage and responses. For calculations, the
old single floor is retained for every available interval; missing precision is
never guessed. Requests from version 1 clients expose only the original approved
observation/focus IDs to the model. Archived selections using newer IDs are
adapted to legacy-approved IDs on readback without changing the stored record or
calling a provider. Invalid packet versions or floor fields fail before any
generation reservation. Lineage IDs and source identity stay local and are not
part of either hosted packet. Packaged iOS builds hide hosted controls and do not
request the hosted status endpoint.

The server uses the AI SDK's OpenAI-compatible adapter against
`https://integrate.api.nvidia.com/v1/chat/completions`. Model access varies by
account; select a text-instruction model actually available to your NIM account.
The current model catalog can be checked at
<https://integrate.api.nvidia.com/v1/models>. Hosted-model structured-generation
extensions are not assumed: plain JSON output is parsed and strictly validated.

## Private-workspace setup

Hosted AI is disabled by default. Do not paste an NVIDIA key into the browser or
chat, commit secrets, or prefix any server secret with `VITE_`.

Configure these **server-only** variables in your hosting settings (or ignored
`.env.local` for local development):

| Variable | Meaning |
| --- | --- |
| `COACHING_ENABLED` | Set to `1` only when ready to enable hosted review. |
| `NVIDIA_NIM_API_KEY` | Your NVIDIA API key. |
| `NVIDIA_NIM_MODEL` | Exact supported text model ID, e.g. the namespace/model format in the catalog. No default is assumed. |
| `COACHING_ACCESS_TOKEN` | Separate random workspace access code, at least 32 characters. Never reuse the NVIDIA key. |
| `COACHING_ALLOWED_ORIGIN` | Exact app origin, e.g. `https://climbiq-detection-lab.vercel.app` or `http://127.0.0.1:5173`. |
| `UPSTASH_REDIS_REST_URL` | HTTPS REST endpoint for an Upstash Redis database you control. |
| `UPSTASH_REDIS_REST_TOKEN` | Server-only Redis credential with GET, SET, EVAL, INCR and EXPIRE access. |
| `COACHING_DAILY_LIMIT` | Integer 1–50; default 5 new generations per UTC day, shared by this workspace. |

No database, paid plan, NVIDIA account, or credentials are provisioned by this
change. Restart the dev server or redeploy after configuring variables. A status
response with `enabled: true` means configuration is present, not that credentials
or provider availability have been validated. Test one authorized review before
sharing access. NIM calls have a 20-second timeout, 700 output-token cap and no
automatic SDK retry. The daily count is not a monetary spending guarantee; also
configure provider-side limits where available. Cost is recorded as unknown
(`null`) because no verified account-specific price is configured.

This is a **private demo workspace**, not public multi-user authentication.
Anyone holding its access code and a review ID can retrieve that review. Do not
share the code publicly. A public release needs individual authentication,
per-user ownership/quotas and an account deletion/retention workflow first.

## Privacy, storage and failure behavior

The separate opt-in sends only bounded numeric metrics and policy enums. Videos,
frames, raw source timestamps, names, file names, locations and notes stay out of
the request. NVIDIA receives approved numeric evidence; Redis retains the numeric
packet, model, generation ID, timestamps, raw generated output, validated plan,
usage and unknown cost. These records do not expire automatically. The workspace
owner is responsible for access, backups, retention and deletion through Redis.

A `nanoid` generation ID and pending database record are reserved atomically
**before** inference, together with deduplication pointers and the daily counter.
Completed output must be saved before being returned. Requests with the same
request ID or identical evidence/model/policy reuse the existing record.
Provider errors consume a reservation too; there is no automatic paid retry.
If completion storage fails, the pending reservation prevents a duplicate call.
It may need owner investigation rather than blindly clearing it and paying again.

Saved review links reopen the panel; enter the workspace access code and select
**Load saved review**. The code stays in memory, never in a link or browser storage.
Archived reviews have no local-video seek links because the numeric record does
not establish which video is loaded. Failed/pending records are retained for
inspection and are never displayed as completed AI advice.

## Verification scope

Policy and server tests cover provenance, privacy, input validation, mandatory
limitations, mocked NIM HTTP requests, output rejection, auth, origin checks,
bounded bodies, reservation ordering, duplicate requests, budget refusal,
persistence failure and authenticated readback. The actual SDK adapter is tested
against mocked HTTP responses. Live NIM inference and live Redis persistence
still require configured credentials; unit tests are not evidence of account access.

The isolated browser harness uses synthetic sessions and mocked hosted responses.
It checks the total and phase table, offsetting changes, strongest-section
priorities, baseline confirmation, saved reviews without video, stale source
links and replies, and the packaged-app policy without contacting a provider.
That platform-policy check does not replace testing the actual iOS build on a
device.
