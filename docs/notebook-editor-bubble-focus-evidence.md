# Markdown bubble menu focus ownership

## Problem and bounded change

Seven native table Tab events select the text of the final cell. The real
`MarkdownSelectionMenu` becomes visible for that nonempty selection. Its
`BubbleMenu` wrapper is appended to `document.body`; the installed Tiptap blur
handler treats focus anywhere inside the wrapper's parent as menu-owned focus.
Moving to the document header therefore leaves the selection menu visible after
the editor loses focus. The Dashboard's existing popup-first Escape handler sees
that orphaned menu, but the menu's editor/menu key handlers do not receive the
header's Escape. The body-mounted table bubble has the same outside-blur defect.

`useMarkdownBubbleMenuFocus` now observes editor blur and document focus entry.
Each menu owns only its editor, its own root and explicitly referenced child
portals. Outside focus hides the bubble through its existing presentation
metadata. It does not restore focus or change document content or selection.
Table dropdown portals remain owned by their table bubble. The Dashboard Escape
handler, document representation, permissions and mobile terminal policy are
unchanged.

## Actual local regression evidence

Base: `8356829c937a8081b3c845bc62005effedde200e`. The preserved pre-fix
selection and table components from that exact base reproduce both defects with
the real Dashboard, local MarkdownEditor, Tiptap BubbleMenu and Radix primitives.
The header-Escape control fails because focus stays enabled; the table control
fails because the bubble remains connected after outside header focus. The local
selection repro records `defaultPrevented=false`. This is separate evidence from
the original V8 browser failure, which did not retain the mobile event/DOM state.

Run `npm run test:notebook:editor-bubble-focus` for the permanent regression:

- Seven actual Tab key events select `Last value`; mobile resize, header
  Focus/Exit/Focus and header Escape hide the orphaned menu and exit focus.
- First editor Escape dismisses its selection popup while retaining document
  focus; the next caret Escape exits document focus.
- Alt+F10 enters the actual selection menu and preserves it; subsequent header
  focus hides it without forcing editor focus.
- The actual Radix table dropdown auto-focuses a portal outside the bubble root;
  the bubble remains visible. Dropdown Escape restores its editor focus without
  exiting document focus. Later outside header focus hides the table bubble.
- The same actual editor DOM, native selection, document JSON and local undo
  history survive these transitions. Actual undo/redo reverses/restores the edit.

JSDOM supplies fixed element/range rectangles, scrolling and CSS identifier
escaping because it does not implement browser layout. Editor/menu/keyboard
handlers are real. This gate proves local lifecycle and native editor state;
physical mobile geometry, collaboration sockets and the original owned-browser
acceptance remain separate requirements.

## Validation and preserved browser evidence

The focused regression, existing responsive Dashboard lifecycle, editor
interaction lifecycle, actual local MarkdownEditor lifecycle, notebook
layout/chat controls, Markdown form/readonly and mobile viewport gates pass.
Scoped ESLint and full TypeScript validation accompany this change. The four
original browser suites, their assertions, seeds and timeouts, Dashboard Escape,
layout reducer and viewport controller retain their original bytes.

The V8 branch, whole production build and private browser failure/cleanup proofs
are preserved. V8 had six passed Create/Paste/Import cases and one failed Focus
case at its second mobile Escape; Links and Restart did not start. No new
production build, host, issuer, database, container or browser run accompanies
this focused source change. Integration requires a new source freeze, genuine
build, independently checked seal and separately coordinated browser start.
