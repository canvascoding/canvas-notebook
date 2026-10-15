# Workspace file discovery without a fixed directory depth

## Problem

The Studio reference picker and automation directory picker search truncated
root trees. Mobile file search and Notebook listing build trees of depth 12 and
then discard entries beyond fixed collection limits. A file can therefore exist
and remain undiscoverable. Raising the tree endpoint's per-request depth does
not solve this and makes the initial request more expensive.

## Implementation order

1. Extend the shared workspace catalogue to retain directories, including empty
   directories, while preserving the existing file-only catalogue contract.
   Traverse without a fixed depth, keep filesystem concurrency bounded, and
   propagate incomplete-scan errors. Extend `/api/files/list` with entry-type
   and extension filters applied before bounded pages. Bind pagination to the
   requested workspace and search parameters.
2. Use direct-directory loading for Studio browsing and a paginated, debounced
   workspace-wide media search. Never treat an unloaded directory as empty.
   Preserve source workspace URLs, selections, and stale-response guards.
3. Use the same loading/search mechanics in the automation directory picker.
   Keep empty folders selectable. Remove fixed root-tree limits from mobile
   file search and Notebook listing using the shared catalogue. Preserve mobile
   response and cursor contracts, and distinguish bounded content search from
   complete filename/path discovery.
4. Make full file lists, including explorer search and email attachment browsing,
   able to retrieve later pages. Keep intentionally short autocomplete suggestions
   bounded; those already search the complete catalogue.
5. Run focused service/client/component tests, a production build, and real
   desktop/mobile browser E2E against this worktree. Publish the branch and create
   a PR targeting `main` with verification evidence and screenshots.

## Acceptance evidence

- Browse and find images and empty directories at least 18 levels deep.
- Media filters run before pagination, even with more than 500 other files.
- Later result pages remain reachable, without duplicates or mixed workspaces.
- Old search/directory responses cannot overwrite a newer workspace or query.
- An unreadable subtree is an error, not a successful empty/complete scan.
- New and existing Studio models can import an image from another readable
  workspace; encoded filenames remain valid.
- Automation folder selection and mobile filename/path discovery have no fixed
  application depth or total-catalogue cutoff.
- Desktop and 390px browser interactions work through real authenticated APIs.
- Only owned test workspaces/data are cleaned up. No container build is needed.

The tree endpoint retains its per-request depth bound. Navigation uses shallow
requests relative to each opened folder, so this does not limit navigable depth.

Completed verification and reviewed desktop/mobile screenshots are recorded in
[the acceptance evidence](workspace-file-discovery/verification.md).
