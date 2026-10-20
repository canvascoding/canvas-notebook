# Workspace export and migration acceptance

Requested scope: export one selected workspace, export all workspaces, and exercise the migration upload, inspection, mapping, and restore lifecycle. Browser acceptance follows the non-browser checks.

## Environment and evidence policy

- Checkout: `99b4/canvasstudios-notebook`, baseline `a9b89776ab92414e0917731717eeb83eb3bf8c80`.
- Reuse the PostgreSQL service of the managed `canvas-local-team-seat-dev` stack. Source and target use separate snapshot databases and private data roots. Run only one acceptance application at a time, on loopback port 3001.
- Existing application containers, port 3000, and the original Notebook database/data root are retained. Mutations use the two acceptance snapshots. Development-license activation and membership synchronization use the existing managed Control Plane. No container build is part of this test run.
- Bootstrap credentials come from the private managed environment. Passwords, cookies, runtime env files, and actual exported user data are excluded from committed evidence.
- Downloaded ZIPs are checked by entry path, byte length, and SHA-256, rather than treating a click or an HTTP 200 as a successful export.
- A staged restore is not a completed restore. Check persistent files, target identity, authentication/session behavior, and pending state after restarting the real application.
- Record failures as failures. PostgreSQL metadata without a dump is not a complete database migration.

## QA inventory

| ID | Claim or control | Functional evidence | Visual evidence |
| --- | --- | --- | --- |
| ENV | Current checkout and isolated source/target | Build result, health, database/data root checks | Login and settings readiness |
| WS1 | Selected workspace determines export | Active workspace differs from selected; compare exact ZIP bytes | Workspace selector, identity, statistics |
| WS2 | All supported workspace types | Personal, organization, team, project fixtures | Correct selected type and permission hints |
| WS3 | Workspace selection does not race | Rapid selection changes; final stats and ZIP belong to final selection | Stable final selection and stats |
| WS4 | Folder/file fidelity | Nested and empty directories, Unicode/spaces, duplicate basenames, binary bytes | Download completes |
| WS5 | Current document content | Edit Markdown and Excalidraw immediately before download | Document contents before export |
| WS6 | Empty workspace | Zero files; disabled action or valid empty ZIP policy | Empty state and disabled button |
| ALL1 | Standard/full-admin profiles | Compare manifest and archive entries | Profile switch and personal-workspace option |
| ALL2 | Explicit personal inclusion | Default excludes, explicit full-admin inclusion contains all fixtures | Inclusion hint and checkbox |
| ALL3 | Component selection | File-only and selected assets/uploads/agent/skill fixtures | Checkbox state, progress, final download |
| AUTH | Scoped export authorization | Owner, normal member, administrator, foreign personal, anonymous HTTP requests | Permission message/disabled action |
| ERR | Export failures are recognizable | Missing ID/file, source changes, unsafe paths, symlinks, ZIP limits, collisions | Download failure state and retry behavior |
| UP1 | Small and multi-chunk uploads | Final archive SHA-256 and complete inspection | Progress and completed inspection |
| UP2 | Rejected uploads do not stage restore | Corrupt archive, missing/short chunks, unsafe ZIP entry, unsupported schema/version | Rejection and disabled restore |
| MAP | Mapping is explicit | Matching IDs, differing users/organizations/projects; no silent remapping | Mapping lists and blocker reasons |
| SEC | Portable export excludes managed credentials | Sentinel secret, OAuth/public-link token checks, reconnect manifest | Reconnect requirements and archive warning |
| REST | Actual file migration | Stage on isolated target, restart, compare source/target bytes and pending state | Confirmation, response, post-restart file opening |
| DB | PostgreSQL capability is represented honestly | Database selection, manifest backup kind/artifact, blocked inspection, unchanged target | Database label and blocker message |
| VIEW | UI remains usable | Desktop 1440x960 and mobile 390x844; no horizontal clipping | Selection, dense inspection, errors in both viewports |
| CLEAN | Cleanup preserves existing environment | Stop owned application; compare retained service identities and source state | Not applicable |

## Existing focused checks

- `npm run test:migration:upload`
- `npm run test:workspace:switcher-ui`
- `npm run test:secrets:recovery`
- `npm run build`

## Results

See [RESULTS.md](RESULTS.md) for the executed checks, reproduced failures, and limits of the acceptance result. The product source is unchanged; this change adds regression tests and the QA report.
