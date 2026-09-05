# Standalone update releases

Standalone installations do not use the Control Plane release catalog or its
credentials. The host updater reads the latest stable GitHub Release asset
`canvas-notebook-update-stable.json` and verifies its Ed25519 signature against
`/etc/canvas-notebook/update-trust.json` before downloading or executing anything.

## Build and publication

1. The normal tag-triggered **Build and Push (Both Arch)** workflow builds and
   tests the exact tag, records the multi-architecture image digest and both
   Linux CLI checksums, and signs that metadata using
   `CANVAS_UPDATE_SIGNING_PRIVATE_KEY`. A missing key or a key that does not match
   the public installer trust store fails the build.
2. The signed manifest is included in both `release-bundle-VERSION` and the small
   `standalone-update-VERSION` artifact. Release publishers should upload the
   signed manifest together with the other assets from the same successful run.
   Never regenerate the manifest locally or substitute a different build.
3. Publishing the GitHub Release triggers **Publish Standalone Update**. It finds
   the successful push build for the exact tag and commit, compares public
   release metadata with that build, verifies the signature with the shipped
   public key, and hashes the actual public amd64 and arm64 CLI archives. It
   attaches the signed manifest if missing and downloads it again to verify the
   published bytes. An existing different manifest is never overwritten.
4. Wait for this workflow to succeed before announcing standalone update
   availability. It runs independently of **Notify Control Plane Release**;
   neither workflow requires the other service's availability or credentials.

Only published stable calendar-version releases are supported by this pipeline.
The manifest references an immutable image digest and immutable tag-specific CLI
URLs, requires a backup, and imposes no additional minimum-version policy. If a
future migration requires a minimum version, change and test the signing policy
before publishing that release. There is no unsigned fallback.

The publication workflow can be retried via `workflow_dispatch` with an already
published tag while its 90-day build artifact is retained. It does not build,
create a release, promote a Control Plane deployment, or overwrite assets.

## Trust provisioning and rotation

`install/keys/update-trust.json` contains only public keys. The installer copies
it into `/etc/canvas-notebook/update-trust.json`; the complete host CLI package
ships the same file. The signing private key is a repository Actions secret,
available only to the manifest-signing step of the release build. It must never
be included in source, artifacts, application integration settings, or logs.

Installations created before the public trust store shipped need the updated
host installer applied once by their administrator. An installation without a
trusted key must not bootstrap trust from an unverified update manifest. A
custom `CANVAS_UPDATE_TRUST_STORE_SOURCE` remains supported by the installer.

For rotation, first distribute an overlapping trust store containing the old
and new public keys to hosts, then switch the Actions signing secret and key ID.
The Linux CLI self-update does not replace the host trust store. Do not retire
the old key or sign exclusively with the new key until the host trust-store
rollout is complete. If the secret is lost, generate a replacement and perform
that controlled trust-store rollout; do not silently replace the signing key.

## Verification

- `npm run test:release:updates`: signing and runtime verification for both
  architectures, tamper rejection, exact-build provenance, published archive
  checksums, and workflow wiring.
- `npm run test:release:host-cli`: reproducible package including public trust.
- `npm run test:cli:updater` and `npm run test:install:updater`: host lifecycle,
  cancellation/apply barrier, download deadline, and installer regressions.
- `npm run test:system-updates`: UI recovery and state reconciliation, including
  rendered JSDOM tests during simulated downtime. These are not real-browser or
  live Linux/systemd tests.
