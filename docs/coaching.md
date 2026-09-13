# Evidence review and NVIDIA NIM

The Coaching review panel is an experimental review assistant, not a validated
technique coach. It does not change Start, Finish, Hold 10, or pose results.

## What works without a server

After loading a video, choose **Review my run**. The local rules summarize accepted
timing, explicitly reviewed Hold 10 phases, and current tracking availability.
They withhold low-confidence timing and unreviewed contact conclusions. To compare
a saved baseline, confirm it is the same climber and a comparable setup.

The result is labeled **Local evidence review · not AI**. Links seek the current
video without accepting or changing markers. Changing analysis evidence resets
the review. Small differences within the existing comparison policy are not
presented as improvements; that policy is not an independently measured error bound.

## What NIM adds

NVIDIA NIM selects up to three observations and one next review focus from an
approved catalog. The browser renders canonical text, never model-written timing,
diagnoses, causes, or training prescriptions. All evidence limitations remain
visible regardless of the model selection. This is AI prioritization, not free-form
coaching or direct video understanding.

The server uses the AI SDK's OpenAI-compatible adapter against
`https://integrate.api.nvidia.com/v1/chat/completions`. Model access varies by
account; select a text-instruction model actually available to your NIM account.
The current model catalog can be checked at
<https://integrate.api.nvidia.com/v1/models>. Hosted-model structured-generation
extensions are not assumed: plain JSON output is parsed and strictly validated.

For `nvidia/nemotron-3.5-lightning-30b-a3b`, the adapter disables reasoning with
`chat_template_kwargs.enable_thinking: false` so the short response budget is
available for the JSON selection. Other models receive no reasoning override.
NVIDIA documents this flag in its [Lightning setup guide](https://docs.nvidia.com/nim/large-language-models/2.0.10/get-started/advanced/get-started-nemotron-3.5-lightning.html).

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

When using the Vite dev server on the configured `localhost` or `127.0.0.1`
origin, the app connects automatically: no workspace code needs to be entered.
The dev middleware supplies it server-side only for same-origin browser requests
from a loopback connection with the expected Host and local-request header.
The browser never receives the code. Consent to send numeric evidence is still
required. Deployed and LAN access retain the workspace-code requirement.

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
