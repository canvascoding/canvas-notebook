# Shared audio transcription

Web dictation, mobile dictation and the Pi `transcribe_audio` tool call `transcribeAudio` in
`app/lib/transcription/service.ts`. It owns format and size validation, provider
dispatch, transcript normalization, cancellation, timeouts, and result metadata.

The instance administrator selects the provider (`local`, `openai`, `groq`, `gemini`, or `wispr`),
model, and default language in **Settings → Dictation**. Each request loads that
selection, or the UI route passes the same settings snapshot used for its
availability check. A tool call may override language and supply vocabulary
context. It cannot select another provider or model.

## Configuration and existing installations

The existing `dictation/settings.json` remains the authoritative configuration.
Its `enabled` flag controls the chat microphone and the UI dictation endpoint.
The agent audio tool uses the selected service independently of that flag and
continues to require the agent's Audio tool permission and authorized file access.

Cloud transcription uses the instance system credential resolved by the shared
Secrets service. Personal and organization keys are not copied into the system
store or used implicitly for this instance service. Missing credentials are
reported with a link to **Settings → Secrets**.

Previously, agent transcription used Groq and selected its model from
`GROQ_TRANSCRIPTION_MODEL` or `VOICE_TRANSCRIPTION_MODEL`. Existing installations
should explicitly select Groq and the desired model in **Settings → Dictation**
and configure a system `GROQ_API_KEY` if they want to retain that provider. Those
model variables no longer override the configured service. Existing saved dictation
settings take precedence; no cloud provider is selected automatically from a key.

The legacy Telegram integration retains its existing integration transcription
service. It is outside this migration.

## Gemini and Wispr

The browser-safe catalog in `app/lib/transcription/config.ts` supplies settings
validation, provider/model selectors and credential names. Credentials remain in
the instance system Secrets store: `OPENAI_API_KEY`, `GROQ_API_KEY`,
`GEMINI_API_KEY`, or `WISPR_API_KEY`. Saving a key does not prove that the remote
API grants access; access errors are reported when transcribing.

- Gemini uses `gemini-3.5-transcribe` through the existing Google GenAI SDK and
  Interactions API. Optional `mode` is `smart` (default) or `verbatim`; older settings
  require no migration. Language and agent vocabulary hints use transcription
  configuration. Interactions set `store: false`. Uploaded audio is deleted in
  `finally`, including failed/cancelled requests, with a separate five-second
  cleanup timeout. A cleanup failure logs a generic warning and preserves a
  completed transcript; deletion is then unconfirmed.
- Wispr uses its documented REST transcription endpoint. API access requires
  approval for the organization by Wispr. `flow` is our service identifier; the
  API chooses its model, and we do not send an undocumented Canto model parameter.
  The server converts native M4A and browser recordings with FFmpeg to 16 kHz mono
  PCM WAV. FFmpeg is already part of the supported container runtime. Conversion
  permits only pipe input/output protocols, uses no temporary files and is bounded
  by the shared request timeout, output cap and Wispr's six-minute audio limit.
  Availability reports a missing converter independently of a missing key.

These adapters process complete audio uploads. Gemini Live and Wispr WebSocket
streaming are separate APIs and are not selected by these file transcription paths.

Provider references: [Google transcription](https://ai.google.dev/gemini-api/docs/transcribe),
[Wispr access](https://api-docs.wisprflow.ai/quickstart),
[Wispr REST quickstart](https://api-docs.wisprflow.ai/rest_api_quickstart).

## Existing Expo app: mobile contract v1

The mobile bootstrap and public compatibility response advertise `chat.dictation.v1`. The existing Expo client
uses the following server routes without changing its provider selection logic:

- `GET /api/mobile/v1/dictation/availability`: a v1 envelope with workspace ID,
  timestamp, readiness and the client's exact audio/text limits.
- `POST /api/mobile/v1/dictation/transcribe`: multipart `audio` (including native
  `audio/mp4` M4A) and `contractVersion=1`; returns `data.text` in the v1 envelope.

Both authenticate and authorize the requested workspace. Transcription shares
the web microphone quota and enable flag, bounds streamed uploads even without
Content-Length, passes caller cancellation and uses one settings snapshot.
Provider/model fields supplied by an upload cannot override server settings.

The existing Expo parser accepts only `local`, `openai`, or `groq` in the legacy
`availability.provider` field, which the current app neither displays nor uses to
route transcription. For v1 compatibility, Gemini and Wispr use `openai` in that
legacy field. The additive `availability.transcriptionProvider` always identifies
the actual provider; `model` is also actual. New consumers should read
`transcriptionProvider`, rather than infer the upstream API from the legacy field.
The shared service, web UI and agent tool always retain actual provider identity.
The old Expo parser ignores the additive field and needs no changes or rebuild.

## Boundaries

- The UI route owns authentication, rate limiting, upload handling, and the
  microphone enable check. The adapter returns the shared transcript text.
- The agent tool owns path resolution and file authorization before reading an
  audio file. It returns the shared transcript, provider, model, and elapsed time.
- The service accepts at most 25 MB and validates supported audio MIME types,
  including codec parameters and known extensions for unspecified MIME types.
- Cloud requests combine caller cancellation with a 90-second timeout.
- Local requests use the existing verified runtime and model installation. There
  is no automatic cloud fallback. The reviewed whisper.cpp runtime retains its
  ten-minute audio limit.
- The local worker queue is shared within the process, admits at most two jobs,
  and dispatches one at a time. Cancellation detaches the caller while the worker
  retains the active audio file and its capacity slot until processing finishes.
  A queued job can be cancelled without affecting another request.

## Verification

### Local model preparation and Settings tests

Settings offers **Download and test model** for the selected local model. It uses
an admin-only background job, without saving the draft provider/model or enabling
the chat microphone. `/api/admin/dictation/local-test` starts the job (POST) and
returns persistent status (GET). `/api/admin/dictation/local-test/recording` accepts
a bounded microphone upload and tests the draft local model through `transcribeAudio`.
It cannot select a cloud provider. Both mutation endpoints are rate limited.

Both installers publish phase, model, downloaded bytes, total bytes and update
time atomically. The container retains pinned size/SHA-256 verification and atomic
activation. The host downloader resolves a concrete public Faster-Whisper repository
revision, checks every file's size and LFS SHA-256/Git blob digest and activates a
complete directory under `DATA/dictation/models`. It uses no Hugging Face token.
Existing host cache files are retained; the first preparation imports a verified
model into the explicit model store. Host first-use downloads run before the local
worker's transcription timeout, and the worker subsequently opens local files only.

The progress bar represents actual bytes during download. Runtime installation,
verification and transcription have indeterminate indicators. A single preparation
job holds a renewable filesystem lease; duplicate requests join it, another model
is refused, and interrupted jobs can be retried. Closing the page detaches the UI
while the server continues. Jobs have a 20-minute preparation deadline, separately
from the local worker's three-minute transcription deadline.

After installation, a bundled public-domain English JFK recording runs through the
shared local transcription service. Success requires recognized reference words;
it reports transcript, model, elapsed time and timestamp. This checks execution,
not general transcription quality. Saved success is invalidated if the model
receipt/runtime identity changes. The additional microphone test uses the existing
recording component with the admin local test endpoint. Changing model/language
resets its transcript and stops an active recording.

`npm run test:dictation:preparation` checks installers, job persistence, interrupted
jobs, modified model receipts, admin gates, quotas, bounded uploads and shared
service dispatch. `npm run test:dictation:e2e` requires the managed local server and
bootstrap credentials; `CANVAS_MICROPHONE_TEST_ENV_FILE` selects its private env.
The browser script uses actual local ASR and an audio-backed fake microphone on
desktop and narrow viewports, checks page reload and model isolation, then uses
explicit transport fixtures for deterministic failure/retry/progress rendering.
Container acceptance requires a current rebuilt/recreated image separately.

Run the service, route, and agent adapter regression scripts alongside the local
worker and Python protocol tests. Browser acceptance covers provider/model/language
selection, readiness while the microphone is disabled, credential errors, and
the unchanged text-insertion flow. Deterministic provider responses in tests are
fixtures; they do not establish external provider availability or container
acceptance.

`npm run test:transcription` includes Gemini/Wispr request fixtures, real FFmpeg
conversion of WAV/M4A/WebM and mobile v1 route/contract regression tests. The latter
use the unchanged Expo parser when its checkout is available, or a pinned parser
fixture for standalone CI (`CANVAS_MOBILE_CLIENT_DIR` selects a checkout).
`scripts/dictation-credentials-test.ts` checks instance credential scope.
`scripts/transcription-settings-browser-test.ts` exercises provider/model/mode,
key feedback and saving on desktop and a narrow viewport with mocked settings
responses; it does not change real keys or make upstream transcription calls.
