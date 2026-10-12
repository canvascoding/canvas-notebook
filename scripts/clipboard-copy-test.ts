import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

import {
  codeBlockClipboardContent,
  codeBlockToClipboardHtml,
  plainTextToClipboardHtml,
  richContentToClipboardHtml,
  writeClipboardContent,
} from "../app/lib/clipboard/browser";

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

async function main() {
  const dom = new JSDOM();
  try {
    for (const text of [
      "", "\n", "\n\nIndented\n\n\n\nEnd\n\n", "  leading\tspaces  ",
      "- literal bullet\n1. literal number", "<script>alert(1)</script> & \"quotes\"",
      "First\r\n\r\n\r\nLast\r",
    ]) {
      const content = codeBlockClipboardContent(text);
      assert.equal(content.plainText, text, "plain text retains every original character");
      const container = dom.window.document.createElement("div");
      container.innerHTML = content.html ?? "";
      container.querySelectorAll("br").forEach((br) => br.replaceWith("\n"));
      assert.equal(container.textContent, text.replace(/\r\n?/g, "\n"),
        "HTML retains every line, blank line and indentation");
      assert.equal(container.querySelectorAll("pre, code, ul, ol, script").length, 0,
        "literal code must not become rich code styling, lists or active HTML");
      if (text) {
        assert.equal((container.firstElementChild as HTMLElement).style.fontSize, "inherit");
        assert.equal((container.firstElementChild as HTMLElement).style.whiteSpace, "pre-wrap");
      }
    }
    assert.notEqual(codeBlockToClipboardHtml("A\n\nB"), codeBlockToClipboardHtml("A\n\n\n\nB"));

    const source = dom.window.document.createElement("div");
    source.innerHTML = '<p class="text-xs">Intro <strong>bold</strong> <a href="https://example.test">link</a></p>'
      + '<div class="markdown-code-block"><div>text<button><svg></svg></button></div>'
      + '<pre style="font-size:10px"><code>First\n\n\n\n  Last\n</code></pre></div><p>After</p>';
    const original = source.innerHTML;
    const rich = dom.window.document.createElement("div");
    rich.innerHTML = richContentToClipboardHtml(source);
    assert.equal(source.innerHTML, original, "copying cannot change the rendered message");
    assert.equal(rich.querySelectorAll("pre, code, button, svg, [class]").length, 0);
    assert.equal(rich.querySelector("strong")?.textContent, "bold");
    assert.equal(rich.querySelector("a")?.getAttribute("href"), "https://example.test");
    const literal = rich.querySelector<HTMLElement>('[style*="pre-wrap"]')!;
    literal.querySelectorAll("br").forEach((br) => br.replaceWith("\n"));
    assert.equal(literal.textContent, "First\n\n\n\n  Last", "whole-message copy excludes the code language header");

    const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
    const originalClipboardItem = Object.getOwnPropertyDescriptor(globalThis, "ClipboardItem");
    let plainWritten = "";
    let richWritten: Record<string, Blob> | undefined;
    Object.defineProperty(globalThis, "navigator", { configurable: true, value: { clipboard: {
      writeText: async (text: string) => { plainWritten = text; },
      write: async (items: Array<{ representations: Record<string, Blob> }>) => { richWritten = items[0].representations; },
    } } });
    Object.defineProperty(globalThis, "ClipboardItem", { configurable: true, value: class {
      constructor(public representations: Record<string, Blob>) {}
    } });
    try {
      const content = codeBlockClipboardContent("\n  First\n\n\n\nLast\n");
      await writeClipboardContent(content, "formatted");
      assert.equal(await richWritten!["text/plain"].text(), content.plainText);
      assert.equal(await richWritten!["text/html"].text(), content.html);
      await writeClipboardContent(content, "plain");
      assert.equal(plainWritten, content.plainText);
      Object.defineProperty(globalThis, "navigator", { configurable: true, value: { clipboard: {
        write: async () => { throw new Error("Rich clipboard rejected"); },
        writeText: async (text: string) => { plainWritten = text; },
      } } });
      plainWritten = "";
      await writeClipboardContent(content, "formatted");
      assert.equal(plainWritten, content.plainText, "rejected HTML falls back without changing blank lines");
      Reflect.deleteProperty(globalThis, "ClipboardItem");
      plainWritten = "";
      await writeClipboardContent(content, "formatted");
      assert.equal(plainWritten, content.plainText, "older browsers preserve the plain representation");
    } finally {
      if (originalNavigator) Object.defineProperty(globalThis, "navigator", originalNavigator);
      else Reflect.deleteProperty(globalThis, "navigator");
      if (originalClipboardItem) Object.defineProperty(globalThis, "ClipboardItem", originalClipboardItem);
      else Reflect.deleteProperty(globalThis, "ClipboardItem");
    }
    console.log("Clipboard literal code, rich messages and fallback tests passed");
  } finally {
    dom.window.close();
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
