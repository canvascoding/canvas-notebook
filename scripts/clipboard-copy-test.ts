import assert from "node:assert/strict";

import { plainTextToClipboardHtml } from "../app/lib/clipboard/browser";

assert.equal(
  plainTextToClipboardHtml("Hallo <Team>\n\nViele Grüße"),
  "<p>Hallo &lt;Team&gt;</p><p>Viele Grüße</p>",
  "paragraphs and HTML-sensitive characters should be safe for formatted pastes",
);

assert.equal(
  plainTextToClipboardHtml("- Lebenslauf\n- Notenspiegel"),
  "<ul><li>Lebenslauf</li><li>Notenspiegel</li></ul>",
  "simple bullet lists should remain lists in a formatted email paste",
);

assert.equal(
  plainTextToClipboardHtml("1. Erster Schritt\n2. Zweiter Schritt"),
  "<ol><li>Erster Schritt</li><li>Zweiter Schritt</li></ol>",
  "simple ordered lists should remain lists in a formatted email paste",
);

assert.equal(
  plainTextToClipboardHtml("Zeile eins\r\nZeile zwei"),
  "<p>Zeile eins<br>Zeile zwei</p>",
  "line endings should be normalized for HTML clipboard data",
);

console.log("Clipboard copy formatting test passed");
