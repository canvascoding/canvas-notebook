# Native API and SDK checks

`.github/workflows/native-api-sdk.yml` runs one serial job against an ephemeral
PostgreSQL 18 service bound to the runner's loopback interface. It runs the API
contracts/component tests, the complete native API package, native agent list,
Read and prompt checks, the public MCP path HTTP suite, and the installed Python SDK HTTP suites. It builds a
wheel and source distribution from the checkout and installs both into fresh
Core, MCP and MCP/Keyring environments on Python 3.10 and 3.15. Each environment
checks dependencies, the exact installed runtime file set and bytes, and the
applicable SDK tests. The MCP/Keyring wheel environment runs all native SDK
families over real loopback HTTP against the actual PostgreSQL-backed handlers.

Before those tests, the job builds and verifies the platform's native filesystem
helper with `build:fd-publication` and `verify:fd-publication`. Copy directory
inventory and no-replace path moves require that helper on Linux as well as
macOS. Its generated binary/manifest are intentionally absent from a fresh
checkout; building decision models alone does not supply them. Missing or
invalid artifacts fail the tests instead of selecting another IO backend.

Source/projection coordination uses actual independent processes and the shared
kernel lock. The public MCP path suite adds real signed tokens, current SQL
grants and the actual HTTP dispatcher. Its Move/Delete preview cases start an
independent writer during source observation and require successful previews,
unchanged native data and completed writer/resource cleanup. A separate negative
case keeps rejecting a projection changed outside the locking protocol. Issuing
a signed fixture token here does not replace genuine browser OAuth acceptance.

The native API package also runs `test:api-keys:migration:native` against a
nonce-owned database initialized by the real runtime migrations. Five storage
groups verify source-key exclusion from portable exports, actual restore commit
and rollback with unchanged target credentials, target-only user retention,
injected-credential rejection and continued rejection of unknown tables.
Instance-bound original-import associations reset; document/native state and
durable file-import receipts retain their copy policy. Declared storage fixtures
do not establish authenticated HTTP or compiled restart/backup/restore acceptance.

## Database selection and cleanup

CI requires `CANVAS_NATIVE_TEST_DATABASE_URL` and `CANVAS_NATIVE_TEST_RUN_ID`.
`DATABASE_URL` and a private host ENV file cannot supply a missing CI target.
The URL must select `canvas_native_ci_<32 lowercase hex characters>` on an
explicit IPv4 loopback port. Before creating schemas or child databases, the
fixtures query the actual server and verify PostgreSQL 18, database name,
ownership and the exact `canvas-native-tests:<run ID>` database comment.

`npm run test:api-keys:ci-database -- create` allocates that database and writes
its identity receipt to a private, owned directory. It exports the fixture
selection through GitHub's environment file. This CLI uses the disposable,
credentialless CI service; it refuses to export a runtime database password.
The regular local probe uses its explicit maintenance connection in memory.

The `always()` cleanup step validates the receipt's filesystem identity and
the current database OID, owner and marker before deleting anything. It removes
only this run's marked root/child databases. Remaining fixture schemas, public
relations, connections or child databases make the gate fail even after owned
resources are removed. A mismatched identity refuses deletion. Test evidence
and built SDK artifacts are retained separately from disposable data.

## Local checks

The managed local PostgreSQL and its private, owned
`~/.local/state/canvas-local-team-seat/notebook-host-dev.env` remain the default
outside CI. No additional Notebook container is created by these commands.

```sh
npm run test:api-keys:ci-config
npm run test:api-keys:ci-portability -- --all-api
npm run test:mcp:path-tools:native
```

The portability probe creates its own nonce database on the managed server.
It verifies real identity checks and preserved sentinels after refused cleanup,
then runs either representative fixture families or the complete native API
package plus the agent packages. `--sdk` additionally requires the existing
absolute `CANVAS_SDK_TEST_PYTHON` and `CANVAS_SDK_TEST_WHEEL` selections and runs
the complete installed SDK package. Resources are released before the probe
returns; its private logs remain as evidence.

`scripts/api-key-sdk-install-matrix.py --dist-dir <artifacts> --output <new-directory>`
verifies one interpreter's six fresh installations. Its optional `--github-env`
exports the verified wheel/MCP/Keyring interpreter for the native HTTP suite.

## Scope of evidence

Configuration contracts, component tests, real database tests and installed
SDK HTTP acceptance are distinct layers. Installing the Keyring dependency
does not establish actual OS credential-store acceptance. These gates do not
replace compiled desktop/mobile UI, genuine OAuth issuance/refresh, regular
`test:all`, whole-flow performance/cache acceptance or release/deployment
verification. Review Center, Undo and the separately gated private model,
plugin and Electron specialty environments remain outside this work.

## Published read-example acceptance

`scripts/helpers/python_sdk_documentation_probe.py` is a compiled-product probe,
separate from the ephemeral handler CI. A controller must first verify its owned
fixture and runtime, issue a read key, enable the required MCP tools, and preserve
the prior configuration. It supplies one bounded JSON line on stdin with `origin`,
`key`, `workspaceId`, `document` (`documentId`, `path`), `sourceCount`, `nonce`,
`wheel` and `wheelSha256`. The current probe requires the managed loopback origin
`http://127.0.0.1:3100` and the installed published SDK 0.1.1. Credentials must not
be passed as command-line arguments. The controller owns key revocation, session
cleanup, settings restoration and the independent preservation checks.

The probe runs the REST search JSON and Python `read_first_hit` function extracted
from the public MDX pages, without replacing the SDK or responses. It checks native
ID/version/content parity and the no-hit continuation path on a fixture with more
than eight initialized native candidates. It records documentation and wheel
hashes with bounded HTTP metadata; it emits neither credentials nor document
content. The OAuth entry point is not executed by this key-only probe. Its static
check of the read example's minimal scopes does not establish interactive consent
or refresh acceptance. Execution requires a real compiled fixture; a syntax check
alone is not a passing acceptance result.
