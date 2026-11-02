# Compiled API-key and installed-SDK acceptance

These are explicit acceptance runners for the one managed local Notebook stack.
They do not start another app, rebuild an image, prepare a database, manufacture
a principal or enable Review Center/Undo. Prepare the current production build
and freshly recreate the Notebook through the managed local-stack workflow first.

The ordinary `test:api-keys` package also runs five local harness checks for
private-file ownership, permissions, links, bounds and report redaction. Those
checks use no database or auth substitute and do not establish HTTP acceptance.

## Required inputs

Both runners require two private, owner-only JSON files in the same private
fixture directory. They fail on missing or mismatched inputs instead of skipping.

1. A successful fresh runtime proof, bound to the **current clean commit**, with
   `sourceSha`, `containerId`, `imageId`, `productSourceHashes`,
   `originalRowsXminBytesAndAnchorProofsPreserved: true` and
   `afterOriginalUpload` pointing to the protected-original baseline.
2. The preservation fixture descriptor below. Replace placeholders with the
   actual owned QA fixture identities; they are not defaults or new identities.

```json
{
  "version": 1,
  "databaseName": "canvas_document_qa_<12 lowercase hex digits>",
  "dataVolume": "canvas-local-prod-document-qa-<the same 12 digits>-data",
  "sourceAttemptDigest": "<the original upload archive's 64 hex directory name>",
  "protectedRootRelativePath": "workspaces/personal/<the original workspace>/files",
  "workspaceName": "Shared Test Workspace"
}
```

The baseline contains `operationId`, `documentId`, `databaseName`, `dataVolume`,
the actual `receipt`, `birth`, `document` and `nativeState` rows with their `xmin`,
and fingerprints for `target`, `source`, `attemptRecord` and the three original
upload/create anchors. It is an observation of a regularly persisted original,
not a fixture permission or a replacement Yjs state. The shared helper resolves
the protected target through the actual workspace row, requires its root to
match the held fixture, and reads the archived
source through the supplied digest. Before and after each run it checks the real
rows/files against that baseline in a read-only PostgreSQL transaction.

The runtime must be the labelled `canvas-local-prod-notebook`, healthy on
`127.0.0.1:3100`, with PostgreSQL in external mode and the exact owned DATA volume.
The image revision and critical source bytes must match the clean checkout.
The test obtains bootstrap credentials from the inspected container's existing
environment; credentials are not command-line arguments or new env files.

Other running containers, image/container identities, private input files and
the checkout must remain unchanged. The runners do not perform data repair.
An ownership, snapshot, cleanup or source-binding failure fails the run.

## Credential-management browser cases

```bash
npm run test:api-keys:compiled -- /absolute/runtime-result.json /absolute/fixture.json
```

The four serial cases cover:

- desktop and 390px mobile issuance, one-time display/copy, metadata-only listing,
  grant changes, rotation and revocation;
- actual cookie-free key access to the exact workspace allowlist, rejection of
  management access, and actual rejection of the old/revoked credential;
- lost issuance responses before sending and after the real server commit,
  metadata inspection, exact-request reuse and targeted unknown-key revocation.

All prior cases remain assertions, with zero retries and zero skips. Each case
closes its own contexts and revokes its own credentials. Screenshots are taken
only after closing the secret dialog; automatic screenshots, traces and video
are disabled. The detailed JSON report and stderr are redacted and private.

## Genuine OAuth, actual expiry and macOS Keychain

Build the wheel and install it with the MCP/Keyring extras in a fresh virtual
environment first. Use that interpreter and exact wheel:

```bash
npm run test:api-keys:sdk:oauth:compiled -- \
  /absolute/runtime-result.json /absolute/fixture.json \
  /absolute/venv/bin/python /absolute/canvas_notebook_python-VERSION-py3-none-any.whl
```

This dedicated runner requires macOS and the real macOS Keychain backend. An
unsupported platform or missing secure backend is an explicit failure, not a
plaintext fallback. It does not imply Windows/Linux OS-store acceptance.

The installed distribution, module path, wheel provenance, exact runtime file
set and every runtime file's bytes must match the supplied wheel and checkout.
The actual official MCP provider owns discovery, dynamic registration, PKCE,
the bound callback listener and token exchange. A real browser completes consent
and the normal settings API grants only the nonce-owned workspace.

The test performs real search, paged reads, Create/Edit/Status, two open editors
and reload. It also uses the actual issued token through the SDK's explicit
`access_token` mode. It then waits for the **real server-issued token expiry**;
there is no altered clock, manufactured token or shortened production TTL.
The expired original token must receive HTTP 401. The existing SDK connection
must automatically refresh without another browser consent, storing the new
token in the actual OS store. A separate isolated Python process reads those
stored credentials and performs a successful protected HTTP call.

OAuth URLs travel only in bounded private pipes. Raw tokens are neither report
events nor child arguments. Cleanup uses the observed registered client and its
actual consent identity, retaining the server's original signed connection
reference. It revokes only that grant and its nonce-issued seed key, removes only
its OS-store profile, restores the prior MCP settings and signs out its own
bootstrap session. An uncertain seed issuance is reconciled by its original
request ID. The new test workspace is retained for inspection.

## Evidence boundaries

The successful operational probes on `a3ff44120` established the four original
browser cases and genuine OAuth/Keychain/real-expiry/independent-process access
with the compiled server. These repository runners additionally strengthen
explicit bearer access, expired-token denial and cleanup. Their new executions
must pass before they count as acceptance of those additions.

These checks supplement the native PostgreSQL/installed-SDK CI matrix. They do
not replace the full supported-operation/concurrency/restart/restore matrix,
regular `test:all`, Recovery/link UI, 10/200-source whole-flow measurements,
document-tab-cache acceptance or final release/deployment verification. All
remaining requirements stay in `docs/document-write-database-performance-plan.md`.
