# Mobile Markdown writing viewport

The focused Markdown pane reserves the part covered by the on-screen keyboard
and the overlapping mobile toolbar, including enough scroll range at document end.
Its inset uses the actual visual viewport bottom (`offsetTop + height`) relative
to the pane, so browsers which resize the layout do not receive a second keyboard
inset. The existing iOS toolbar positioning remains unchanged; caret visibility
uses the rendered toolbar rectangle rather than estimating its offset.

Rich and Source share a visibility controller. A visible caret retains its
position. A hidden caret receives a small scroll correction in its own editor,
with room for surrounding text. Window scroll, focus, selection, document and
history are not modified. Explicit Source start/center navigation and mode
handoffs retain their existing policy.

Keyboard resize, input and composition completion may reveal the caret. Scrolling
only updates geometry; wheel/touch gestures cancel an obsolete queued reveal.
Composition defers corrections. Desktop, pinch zoom and unfocused editors use the
normal editor/browser behavior. Listeners, frames and the pane inset are released
on view teardown. Source opts in through the Markdown viewport controller, so
other CodeEditor consumers keep their existing behavior.

## QA inventory

| Behavior | Verification |
| --- | --- |
| Keyboard clips layout while the layout viewport retains its height | Actual Rich/Source component fixtures in Chromium and WebKit with emulated VisualViewport geometry |
| Typing preserves a chosen visible writing position | Real browser tap/type after a staged scroll offset; scroll position stays stable |
| Hidden caret is revealed below surrounding text | Browser typing, caret coordinates and screenshots |
| Pan and toolbar overlap use actual coordinates | Unit scenarios and browser viewport with nonzero offsetTop |
| Undo/redo preserves content; keyboard dismissal restores the pane | Real browser keyboard input in both modes |
| Landscape and document end remain writable | Browser resize, emulated keyboard, End and typing |
| Composition, zoom, blur and teardown | Controller regression tests; browser zoom geometry/dismissal |
| Mode handoffs and guest/local editor behavior | Existing mode-position and editor lifecycle/guest suites |

Commands: `npm run test:editor:mobile-viewport`,
`npm run test:editor:mobile-viewport:e2e`, `npm run test:editor:mode-position`,
`npm run test:editor:local-lifecycle`, `npm run test:editor:guest-controls`.
The mobile browser fixtures bundle the current production components and start
no server/container. They emulate keyboard geometry and scroll offsets; they do
not establish native iPhone/Android keyboard, swipe or IME acceptance, nor native
app WebView acceptance. Those remain device checks.
