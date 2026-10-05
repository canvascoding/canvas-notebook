# Shared audio transcription

UI dictation and the Pi `transcribe_audio` tool call `transcribeAudio` in
`app/lib/transcription/service.ts`. It owns format and size validation, provider
dispatch, transcript normalization, cancellation, timeouts, and result metadata.

The instance administrator selects the provider (`local`, `openai`, or `groq`),
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

Run the service, route, and agent adapter regression scripts alongside the local
worker and Python protocol tests. Browser acceptance covers provider/model/language
selection, readiness while the microphone is disabled, credential errors, and
the unchanged text-insertion flow. Deterministic provider responses in tests are
fixtures; they do not establish external provider availability or container
acceptance.
