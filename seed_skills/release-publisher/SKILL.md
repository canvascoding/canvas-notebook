---
name: release-publisher
description: "Publish a new Canvas Notebook release. Use this skill whenever the user asks to bump a version, prepare release notes, update CHANGELOG.md, create or push a git tag, publish a GitHub Release, or automate the release workflow. This skill covers the full release sequence for this repository: inspect commits/tags, choose the next calendar version, update package and CLI versions, update the changelog, run the required build, commit, tag, push the tag, and publish the release."
metadata:
  version: "1.0"
  author: canvas-studios
---

# Release Publisher

Use this skill to publish Canvas Notebook releases consistently.

## Guardrails

- Read the repository instructions first, especially `AGENTS.md` if present.
- Do not build containers unless the user explicitly asks.
- Do not start multiple dev or test containers.
- Do not use Playwright unless the user explicitly asks or approves it.
- Do not push the branch unless the user explicitly asks. Pushing the tag is allowed when publishing a release.
- Keep user changes intact. If unrelated working tree changes exist, do not overwrite them.
- Commit finished release-prep work before moving to tag or publish steps.

## Versioning

Canvas Notebook uses calendar-style versions:

```text
YYYY.M.D.N
```

Example for the first release on June 6, 2026:

```text
2026.6.6.1
```

Tag names use a leading `v`:

```text
v2026.6.6.1
```

Choose the next version by:

1. Reading the current date.
2. Listing existing tags sorted by creation date and version.
3. If today already has releases, increment the final counter.
4. Otherwise use counter `1`.

## Required Files

Update all of these when bumping the release version:

- `package.json`
- `package-lock.json`
- `install/bin/canvas-notebook`
- `install/lib/shared/output.sh`
- `CHANGELOG.md`

The CLI version lines are:

```bash
CANVAS_CLI_VERSION="VERSION"
CANVAS_CLI_VERSION="${CANVAS_CLI_VERSION:-VERSION}"
```

Because the project uses four-part calendar versions, `npm version` may reject the version. If so, update `package.json` and `package-lock.json` directly with a structured edit.

## Workflow

### 1. Inspect State

Run:

```bash
git status --short --branch
git log --oneline -n 20
git tag --sort=-creatordate --format='%(refname:short) %(creatordate:short) %(subject)' | head -30
```

Check:

- Current branch.
- Whether the tree is clean.
- Whether `main` is ahead of `origin/main`.
- Latest release tag.
- Current version in `package.json`.
- CLI version in `install/bin/canvas-notebook` and `install/lib/shared/output.sh`.

If the tree has unrelated changes, either work around them or ask before touching those files.

### 2. Summarize Changes Since Last Tag

Use the previous release tag as the base:

```bash
git log --reverse --pretty=format:'- %s' PREVIOUS_TAG..HEAD
git show --stat --oneline PREVIOUS_TAG..HEAD
```

Convert raw commit subjects into user-facing release notes. Prefer categories:

- `Added`
- `Changed`
- `Fixed`
- `Security`
- `Verification`

Avoid dumping every tiny commit into the public release body unless the user asks for exhaustive notes.

### 3. Update CHANGELOG.md

Maintain `CHANGELOG.md` using Keep a Changelog style:

```markdown
## [Unreleased]

### Added

- Nothing yet.

## [VERSION] - YYYY-MM-DD

### Added

- ...
```

For a new release:

1. Add a new version section directly below `Unreleased`.
2. Move relevant unreleased items into that section if any exist.
3. Add release notes based on commits since the last tag.
4. Add `### Verification` with the commands actually run.

### 4. Update Versions

Update:

- Root package version.
- Lockfile root version and package entry version.
- CLI version constant.
- Shared CLI output fallback.

Then verify:

```bash
rg -n 'OLD_VERSION|NEW_VERSION|CANVAS_CLI_VERSION' package.json package-lock.json install/bin/canvas-notebook install/lib/shared/output.sh
git diff --check
```

### 5. Build Before Tagging

Always run the production build before committing/tagging a release:

```bash
npm run build
```

If the build injects the CLI version, confirm the injected version matches the new version.

For UI or end-to-end behavior changes, follow the repository instructions. If Playwright is required but the user did not explicitly authorize it, ask before using it.

### 6. Commit Release Prep

Commit the changelog and version bump together unless the user asks for separate commits:

```bash
git add CHANGELOG.md package.json package-lock.json install/bin/canvas-notebook install/lib/shared/output.sh
git commit -m "Prepare release VERSION"
```

Do not include unrelated files.

### 7. Create Annotated Tag

Create an annotated tag on the release commit:

```bash
git tag -a vVERSION -m "Canvas Notebook VERSION"
git show --no-patch --pretty=fuller vVERSION
```

If the tag already exists, stop and inspect. Do not overwrite a published tag unless the user explicitly instructs you to.

### 8. Push Tag

Push only the tag unless the user explicitly asks to push the branch:

```bash
git push origin vVERSION
```

If the local branch is ahead of `origin/main`, mention that the tag points to a commit not reachable from the remote branch. This can be acceptable for a tag-only release, but it is operationally important.

### 9. Publish GitHub Release

Use GitHub CLI:

```bash
gh auth status
gh release create vVERSION \
  --repo canvascoding/canvas-notebook \
  --title "Canvas Notebook VERSION" \
  --notes "..."
```

The release should be published directly unless the user asks for a draft.

Recommended release body:

```markdown
## Highlights
- ...

## Verification
- `npm run build`
```

### 10. Final Report

Report:

- Version.
- Commit hash.
- Tag.
- Release URL.
- Verification commands and result.
- Whether the branch was pushed or remains ahead of remote.

Keep the final response short and factual.

## Failure Handling

- If `npm run build` fails, stop before committing/tagging and fix the failure if it is in scope.
- If `gh auth status` fails, stop before release creation and tell the user what credential is missing.
- If pushing the tag fails, do not create the GitHub Release until the tag is visible on GitHub.
- If `gh release create` says the release already exists, inspect it before editing or replacing anything.

