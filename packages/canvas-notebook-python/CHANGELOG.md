# Changelog

## 0.1.0.dev0 — unreleased

- Separately installable native-document facade over official MCP 2.3.0 Streamable HTTP, with optional external dependencies.
- OAuth authorization-code/PKCE callback lifetime and separate memory/OS-keyring storage for tokens and client registration.
- Native search, version-bound paginated read, creation/import, edit and historical edit-status methods retain the central Canvas contracts.
- Four native Copy methods delegate Preview/Apply/Status/Recover to the explicitly enabled central MCP tool. Collision renaming is Preview-only; Apply/Recover retain the exact resolved roots, original order, caller operation ID and actual plan. Full results and uncertain outcomes remain explicit; no automatic replay, polling or recovery.
- Historical baseline before the SDK Copy additions: wheel/source builds, installations, 26 boundary tests, strict typing and five actual MCP HTTP/PostgreSQL document families passed on their recorded source versions and artifacts.
- That baseline's later compiled local seven-case browser suite passed actual SDK OAuth/document/editor coverage. A separate three-process macOS Keychain check passed dummy persistence, endpoint/profile isolation and cleanup; it was not combined persistent-store OAuth. These results do not validate the new SDK Copy methods. Copy-specific validation is recorded separately from these historical results. Other credential stores and public delivery remain unverified. The package is not published.
