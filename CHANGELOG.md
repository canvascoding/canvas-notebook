# Changelog

All notable changes to Canvas Notebook are documented here.

Versioning scheme: `year.major.minor` — e.g. `2026.1.14`

---

## [2026.1.14] — 2026-03-25

> First release under the new `year.major.minor` versioning scheme.

### Changed
- Switched versioning from semver (`1.0.x`) to `year.major.minor` (`2026.1.x`)
- Updated README with OpenClaw-style header, badges, and MIT license
- License changed to MIT (previously proprietary All Rights Reserved)

### Fixed
- Resolved all `react-hooks/exhaustive-deps` lint warnings
- Security audit fixes, upgraded Next.js to 16.2.1
- Improved qmd entrypoint failure logging

---

## [1.0.13] — i18n: Full Internationalization

- Complete internationalization (i18n) across all app surfaces
- Language switcher in header and onboarding wizard
- German (Deutsch) translation for all UI strings
- Fixed locale-aware auth redirects and routing
- Fixed German umlaut rendering in translations

## [1.0.12] — Mobile Chat & Editor Improvements

- Passed active editor file into AI agent system prompt as context
- Image upload error handling and improved paste behavior
- Mobile chat sheet: removed duplicate close button, added Stop button
- Fixed AI Chat title vertical alignment on mobile

## [1.0.11] — PDF Export & Markdown Preview

- Markdown PDF share: inline images, direct download, mobile UI
- Markdown editor defaults to preview mode
- Fixed PDF print dialog (browser print API)
- Fixed html2pdf.js oklch color parsing error
- Auto-open chat on mobile when navigating from home page prompt

## [1.0.10] — Bug Fixes

- General bug fixes and stability improvements

## [1.0.9] — File Browser & Agent Managed Files

- MarkdownEditor in Agent Managed Files settings
- Improved file browser behavior
- Prioritized filename matches in chat file references

## [1.0.8] — Agent System Prompt & Timezone

- Timezone context added to PI agent system prompt
- Integrated `seed_sys_prompts` folder for agent file initialization
- Allowed PI agent read tool to access `/data/canvas-agent` directory
- System prompt tuning

## [1.0.7] — Media Tools

- Exposed direct PI media tool inputs
- System prompt optimizations

## [1.0.6] — Mobile UX Overhaul

- Full mobile optimization across homepage, notebook, and onboarding
- Desktop notebook panel toggles (chat, terminal, explorer)
- Auto-growing chat composer with bounded max height
- Default theme set to light
- Inline image markdown guidance in chat

## [1.0.5] — ARM64 & OAuth Fix

- Switched compose.yaml to local build for ARM64 compatibility
- Fixed PI OAuth completion flow

## [1.0.4] — Docker Volume Cleanup

- Removed `/ollama` volume — models run externally, settings remain in `/home/node`

## [1.0.3] — Docker Volumes

- Added `/home/node` and `/ollama` to Dockerfile VOLUME declarations

## [1.0.2] — Docker Stability

- Fixed `fatal_startup` called before definition in `docker-entrypoint.sh`
- Sanitized committed test credentials
- CI: build and deploy only on release tags

## [1.0.1] — Docker Hub & Bootstrap

- Merged GHCR and Docker Hub into single build workflow
- Fixed production bootstrap admin startup
- Documented default login credentials and bootstrap sync behavior

## [1.0.0] — Initial Release

- File browser and CodeMirror-based code editor
- Terminal emulator via xterm.js + node-pty over WebSocket
- Spreadsheet viewer (UniverseJS)
- AI agent chat powered by PI framework
- Support for Anthropic, OpenRouter, Google Gemini, Ollama
- SQLite database via Drizzle ORM
- better-auth authentication with bootstrap admin
- Docker Compose deployment
