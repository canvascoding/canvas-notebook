# Dependency patches

`npm run postinstall` applies the versioned patches with `--error-on-fail`.
Apply them to an isolated dependency installation when working in a worktree.

## PDF.js 6.2.108

`pdfjs-dist+6.2.108.patch` makes both distributed viewer modules ignore a
selection callback after their last text layer has been removed. PDF.js otherwise
passes `undefined` to `getComputedStyle` when a queued callback runs after closing
the PDF and selecting text in another editor. The guard is local to PDF.js's
selection handler; normal selection and unrelated browser errors are preserved.

The dependency is pinned to the patch version. Recheck the guard when upgrading
PDF.js. `scripts/pdf-viewer-lifecycle-test.tsx` exercises the installed handler
and the application's delayed render/cancel/unmount boundaries without a browser.

## Yjs 13.6.31

`yjs+13.6.31.patch` adds a `node` export condition ahead of the existing
`module`/`import` conditions. The custom WebSocket host uses CommonJS, while
Next.js can load ESM externals in the same process. Both must resolve to
`dist/yjs.cjs`: separate Yjs constructors break `instanceof` checks in the
document adapters, even when the installed package version is identical.

The patch changes package resolution only. It retains the existing types and
browser ESM entry, and does not modify document algorithms or the binary format.
The root dependency is pinned to the patch's exact version. On a Yjs upgrade,
reassess whether the patch is still necessary, update it deliberately if needed,
and run the production regression after a fresh build:

```sh
npm run build
npm run test:collaboration:production-modules
```

`verify:release` runs this regression immediately after its production build.

The regression combines the TypeScript/CommonJS document helpers used by the
host with the actual validator loaded from the built checkpoint endpoint. It
also checks native ESM/CJS adapters, concurrent block movement and text edits,
unchanged validation bytes, binary reload, and the browser module entry. It
does not start a server or use a database. Its access to the built validator
depends on the installed Turbopack chunk format and fails explicitly if that
format changes; update the probe rather than substituting source-only validation.
