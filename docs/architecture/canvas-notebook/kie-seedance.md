# KIE Seedance contracts

Verified against KIE documentation on 2026-11-16.

## Supported models and transport

Canvas uses KIE for Seedance video generation only. The other Studio providers use their own Google/OpenAI integrations, not KIE's similarly named market models.

| Canvas provider | Exact KIE model | Duration exposed by Canvas | Images / videos / audio references |
| --- | --- | --- | --- |
| `bytedance` | `bytedance/seedance-2` | Integer 4–15 seconds | 9 / 3 / 3 |
| `bytedance` | `bytedance/seedance-2-5` | Integer 4–30 seconds | 30 / 10 / 10 |

Both support text-to-video, first-frame, first-and-last-frame, and multimodal reference-to-video. Frames and multimodal references are mutually exclusive; an end frame needs a start frame. Canvas offers 480p, 720p and 1080p and seven aspect ratios: 1:1, 4:3, 3:4, 16:9, 9:16, 21:9, adaptive. Seedance 2 web search is text-to-video only. Existing default model selection remains Seedance 2.

`studio_generate_video` uses `provider: "bytedance"`. The Control Plane wire provider is `kie`. Both paths preserve the selected model and validate duration, aspect ratio, resolution, reference count, MIME type, byte size and incompatible modes before KIE uploads. The Studio loader fails if an explicitly supplied reference cannot be loaded. Provider-side validation still checks actual media dimensions, frame rate, decodability and reference duration.

KIE uploads use `/api/file-base64-upload` on `kieai.redpandaai.co`. Task creation uses `POST https://api.kie.ai/api/v1/jobs/createTask`, with the exact `model` and snake_case `input`. Polling uses `GET /api/v1/jobs/recordInfo?taskId=...`. The result comes from `data.resultJson.resultUrls`. Authentication is a Bearer KIE key. No callback receiver is installed; both adapters poll.

The scoped `KIE_API_KEY` wins. When absent, the Notebook uses the authenticated managed media transport if configured, with reference roles preserved through storage, upload and task creation. Missing configuration points to `/settings?tab=secrets`. The Control Plane change must be deployed alongside the Notebook for managed Seedance 2.5 use.

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

- KIE also documents Seedance 2 Fast, 2 Mini, 2.5 Flash and 2.5 Draft enhancement. These are distinct model contracts and are not advertised or accepted as aliases for the two supported models.
- Automatic duration (`-1`), explicit edit/extend task types, draft generation/enhancement, returned last-frame artifacts, and MOV selection are not exposed. Canvas generates MP4 with a fixed requested duration. Automatic duration needs output-duration settlement before it can safely use managed billing; draft enhancement needs an existing upstream draft task ID and its own workflow.
- The latest KIE Seedance 2 docs offer 4K. Canvas keeps its existing 480p–1080p subset and rejects 4K rather than silently converting it to 720p.
- Canvas limits prompts to 20,000 characters, below KIE's 20,480-character maximum.
- Provider media limits are model-specific: Seedance 2 video references up to 50 MB, Seedance 2.5 up to 200 MB; images below 30 MB and audio up to 15 MB. Actual media content validation remains with KIE. Local upload/import entry points can impose smaller limits.
- The Control Plane additionally retains its configurable transport limits: 128 MiB HTTP body, 80 MiB total decoded references and 50 MiB per video by default. It rejects oversized requests; these deployment limits must be raised explicitly to transport larger KIE-valid inputs. They are not silently bypassed.

## Managed pricing

Seedance 2.5 has six separate default pricing rows: 480p, 720p, 1080p, each with/without video input. Published USD per second on the verification date: 0.140/0.085, 0.315/0.190, 0.790/0.475 (without/with video). Defaults match the existing Seedance pass-through pricing convention. Configured pricing can override defaults.

With reference video, billable seconds are input-video duration plus output duration. A 30-second input and 30-second output must be 60 units, not 45. If input duration probing is incomplete, the existing explicit fallback accounting now uses the model's maximum total reference duration (30 seconds for 2.5) and marks the duration as missing.

## Sources

- [Seedance 2 OpenAPI](https://docs.kie.ai/market/bytedance/seedance-2.md)
- [Seedance 2.5 OpenAPI](https://docs.kie.ai/market/bytedance/seedance-2-5.md)
- [Seedance 2.5 Draft OpenAPI](https://docs.kie.ai/market/bytedance/seedance-2-5-draft.md)
- [Seedance 2.5 prices](https://kie.ai/seedance-2-5)

## Acceptance

- Direct provider fixtures: both model IDs, task polling/download, 30-second output, all 50 references, early rejection of invalid contracts.
- Internal PI tool registry: Seedance 2.5 and 30-second duration forwarded correctly.
- Authenticated HTTP fixture: Notebook managed fallback through create/poll/download/ack, then the actual Control Plane KIE request builder consumes the serialized request and preserves all reference roles.
- Control Plane contract tests: frame modes, unsupported model variants/options, input/output duration arithmetic, six resolution/input-specific prices.
- Mobile compatibility and reference boundary tests.
- Production build (including the release TypeScript project) passed. Control Plane workspace typechecks passed. The additional unrestricted Notebook `tsc --noEmit` check reports errors in other test scripts (for example capability-package icon capture and workspace source-authority tests); it reports none in the changed files. The first unrestricted run reached its default heap limit, so it was rerun with an 8 GiB heap.
- Playwright against the current Notebook checkout: bootstrap login, Seedance 2.5 selection, 30-second menu, 30/10/10 counters, reload persistence, switch back to Seedance 2 (15 seconds, 9/3/3), and authenticated HTTP 400 responses for 31 seconds and an end frame without a start frame. Desktop layout checked at 1440×1000. The 390px view has no horizontal overflow; the pre-existing tall expanded-options panel clips the top frame controls, so full mobile layout acceptance remains limited.
- No live render: the local test account has neither a KIE credential nor enabled managed media. No containers were built or deployed.

These fixture tests do not prove a billable live KIE generation or a deployed Control Plane upgrade.
