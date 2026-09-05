# Automation configuration cleanup

Web redesign first; the Expo client is a later change.

## Storage contract

Run answers, events and metadata remain in `automation_runs`. The runner no longer creates output directories. Only an explicit task to produce a workspace file may produce that file.

`workspaceContextPaths` and `targetOutputPath` are deprecated input fields for older clients. All three create paths and updates translate supplied values into ordinary, editable prompt instructions. Output hints are conditional on the task explicitly requiring a file; they never instruct the agent to write run logs or metadata. Read responses retain empty/null compatibility fields until the Expo transition is complete.

Existing jobs are migrated in place when jobs are listed, scheduled, or fetched by ID. The migration is idempotent and compares the original prompt, revision and path fields before writing. It preserves job IDs, schedules, delivery targets and historic runs. Other readers normalize unmigrated rows into the same public representation. The physical columns remain for compatibility and historical run reads; dropping them requires the later mobile API transition. No legacy files are deleted.

## Verification

- `npx tsx --conditions react-server scripts/automation-path-migration-test.ts`
- `npm run test:automation:schedule`
- `npm run test:automation:runner`
- `npm run test:automation:workspace-scope`
- `npm run test:mobile:automations`

Browser automation is explicitly disabled by the user for this implementation. Do not claim visual browser verification.

## Web interaction

The overview shows one row per automation and links straight to its summary. Editing is explicit. All three creation flows share task fields, with a searchable agent popover before the prompt. Schedule, chat delivery, templates and advanced options are disclosures. History initially shows five runs; a run opens on its result, and logs/metadata load only when expanded. Chat messages load only when their tab is selected.

The chat picker searches titles and paginates within the executor, agent and workspace. Fixed targets are validated when configured and when executed; unavailable fixed chats fail explicitly instead of silently creating a replacement. The active-chat mode retains its new-chat fallback. UI wording uses Chat; internal session identifiers remain API implementation details.

Pickers share the editor dialog’s Radix focus and dismissal layers. Their portal avoids clipping within the editor, and Escape closes the picker without closing the editor.

## Later Expo work

Reuse `/api/automations/chats` for title search and selection. Mirror the agent-before-prompt order and contextual disclosures. Remove dedicated path inputs and use task text instead. The deprecated path fields can be removed from the shared API only after supported Expo versions have migrated. No Expo repository changes are included here.

Additional verification:

- `npm run test:automation:paths`
- `npm run test:automation:chats`
- `npm run test:automation:delivery`
- `npm run test:automation:ui` (JSDOM, real dialog/popover components)
- `npx tsc --noEmit`
- Targeted ESLint and `npm run build`
