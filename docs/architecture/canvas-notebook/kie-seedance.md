# KIE Seedance contracts

Verified against KIE documentation on 2026-11-16.

## Supported models and transport

Canvas uses KIE for Seedance video generation only. The other Studio providers use their own Google/OpenAI integrations, not KIE's similarly named market models.

| Canvas provider | Exact KIE model | Duration exposed by Canvas | Images / videos / audio references |
| --- | --- | --- | --- |
| Historical jobs only | `bytedance/seedance-2` | Integer 4–15 seconds | 9 / 3 / 3 |
| `bytedance` | `bytedance/seedance-2-5` | Integer 4–30 seconds | 30 / 10 / 10 |

Both support text-to-video, first-frame, first-and-last-frame, and multimodal reference-to-video. Frames and multimodal references are mutually exclusive; an end frame needs a start frame. Canvas offers 480p, 720p and 1080p and seven aspect ratios: 1:1, 4:3, 3:4, 16:9, 9:16, 21:9, adaptive. Seedance 2 web search is text-to-video only. New requests default to Seedance 2.5. Explicit new 2.0 requests fail with `MODEL_RETIRED`. Stored Studio preferences migrate to 2.5 while retaining valid options; historical jobs and their pricing keep 2.0.

`studio_generate_video` uses `provider: "bytedance"`. The Control Plane wire provider is `kie`. Both paths preserve the selected model and validate duration, aspect ratio, resolution, reference count, MIME type, byte size and incompatible modes before KIE uploads. The Studio loader fails if an explicitly supplied reference cannot be loaded. Notebook and Control Plane inspect actual media with bounded ffprobe before upload or credit reservation, including dimensions, aspect ratio, frame rate, per-file and aggregate duration. Unreadable references fail closed.

KIE uploads use `/api/file-base64-upload` on `kieai.redpandaai.co`. Task creation uses `POST https://api.kie.ai/api/v1/jobs/createTask`, with the exact `model` and snake_case `input`. Polling uses `GET /api/v1/jobs/recordInfo?taskId=...`. The result comes from `data.resultJson.resultUrls`. Authentication is a Bearer KIE key. No callback receiver is installed; both adapters poll.

The scoped `KIE_API_KEY` wins. When absent, the Notebook uses the authenticated managed media transport if configured, with reference roles preserved through storage, upload and task creation. Missing configuration points to `/settings?tab=secrets`. The Control Plane change must be deployed alongside the Notebook for managed Seedance 2.5 use. Notebook requires the authenticated `/v1/managed/media-capabilities/kie` contract version 2, advertised model and provider availability. Old or disabled managed installations fail before job creation; deployment byte limits are shown in Studio and exposed in the mobile catalog.

## Internal tool example

```json
{
  "prompt": "A slow cinematic camera move over a quiet beach.",
  "provider": "bytedance",
  "model": "bytedance/seedance-2-5",
  "duration": 30,
  "resolution": "720p",
  "aspect_ratio": "16:9",
  "generate_audio": true
}
```

Use `extra_reference_urls`, `reference_video_urls`, and `reference_audio_urls` for multimodal references; use `start_frame_path` / `end_frame_path` for explicit frames. These accept accessible workspace/Studio references and supported URLs, not arbitrary KIE `asset://` identifiers.

## Explicit boundaries

- KIE also documents Seedance 2 Fast, 2 Mini, 2.5 Flash and 2.5 Draft enhancement. These are distinct model contracts and are not advertised or accepted as aliases for the current model.
- Automatic duration (`-1`), explicit edit/extend task types, draft generation/enhancement, returned last-frame artifacts, and MOV selection are not exposed. Canvas generates MP4 with a fixed requested duration. Automatic duration needs output-duration settlement before it can safely use managed billing; draft enhancement needs an existing upstream draft task ID and its own workflow.
- The latest KIE Seedance 2 docs offer 4K. Canvas keeps its existing 480p–1080p subset and rejects 4K rather than silently converting it to 720p.
- Canvas limits prompts to 20,000 characters, below KIE's 20,480-character maximum.
- Provider media limits are model-specific: Seedance 2 video references up to 50 MB, Seedance 2.5 up to 200 MB; images below 30 MB and audio up to 15 MB. Seedance 2.5 content validation also runs locally before submission. Local upload/import entry points can impose smaller limits.
- The Control Plane additionally retains its configurable transport limits: 128 MiB HTTP body, 80 MiB total decoded references and 50 MiB per video by default. It rejects oversized requests; these deployment limits must be raised explicitly to transport larger KIE-valid inputs. They are not silently bypassed.

## Managed pricing

Seedance 2.5 has six separate default pricing rows: 480p, 720p, 1080p, each with/without video input. Published USD per second on the verification date: 0.140/0.085, 0.315/0.190, 0.790/0.475 (without/with video). Defaults match the existing Seedance pass-through pricing convention. Configured pricing can override defaults.

With reference video, billable seconds are input-video duration plus output duration. A 30-second input and 30-second output must be 60 units, not 45. Seedance 2.5 ignores client-supplied input duration and probes the uploaded bytes. Failed probing rejects the request before reservation; legacy jobs retain their original accounting.

## Sources

- [Seedance 2 OpenAPI](https://docs.kie.ai/market/bytedance/seedance-2.md)
- [Seedance 2.5 OpenAPI](https://docs.kie.ai/market/bytedance/seedance-2-5.md)
- [Seedance 2.5 Draft OpenAPI](https://docs.kie.ai/market/bytedance/seedance-2-5-draft.md)
- [Seedance 2.5 prices](https://kie.ai/seedance-2-5)

## Acceptance (2026-11-16)

The user explicitly requested testing without a KIE key. Only the external KIE HTTP service was replaced by a loopback fixture; no paid/live KIE render or deployment is claimed.

- Direct adapter tests: upload/create/poll/download, explicit MP4/standard multimodal payload, 50 references and invalid-contract rejection.
- Actual Control Plane Fastify routes, scoped instance tokens, encrypted fixture secret, PostgreSQL job persistence, worker, downloaded artifact, usage and credit ledger. Text, first/last frames, 30+10+10 references, provider failure, repeat acknowledgement and pre-reservation rejection passed. The 20-second video input plus 5-second output used 25 units at the video-input price, ignoring false client duration hints.
- Actual `studio_generate_video` tool with an authorized persisted workspace, real Notebook generation service, managed HTTP, Control Plane worker and stored workspace output passed.
- Playwright: real bootstrap login, Studio generation through the same managed server, output details identify 2.5, video loads at readyState 4 with 5-second duration; only 2.5 selectable, 4–30-second menu and 30/10/10 reference counters. A saved 2.0 selection migrated to 2.5 preserving 12 seconds, 1080p and disabled audio.
- Visual checks at 1440×1000 and 390×844: frame controls, deployment limits and Generate remain accessible; expanded options scroll within the viewport. Light/dark presentation inspected. Local macOS ffmpeg lacks the WebP encoder used by the pre-existing thumbnail pipeline; video playback and original MP4 downloads pass, thumbnails remain a local-environment limitation.
- Notebook production build including release TypeScript passed. Control Plane workspace typechecks and media contracts passed. Mobile API, migration, internal tool registration and provider-readiness tests passed.

Reproduce the full fixture integration using `apps/api/tests/seedanceE2eServer.ts` and `seedanceE2eClient.ts` in the companion Control Plane PR. It requires an empty local `canvas_kie_e2e_*` database with the application schema. The server writes private loopback connection state to `/tmp/canvas-kie-e2e/state.json`.

For the internal tool test, load the managed local Notebook environment plus the fixture Control Plane URL/token, set `KIE_E2E_WORKSPACE_ID` to an authorized existing workspace, and run:

```sh
node --env-file=/path/to/private-test.env --conditions=react-server --import ./scripts/helpers/seedance-e2e-esm-bridge.mjs --import tsx scripts/seedance-internal-tool-e2e.ts
```

The ESM bridge loads the real PI packages for the repository's CommonJS tsx test runner; it does not mock application services. Test outputs are retained in the selected workspace.
