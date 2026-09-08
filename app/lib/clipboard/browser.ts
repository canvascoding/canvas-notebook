"use client";

export type ClipboardCopyMode = "plain" | "formatted";

export type ClipboardContent = {
  plainText: string;
  html?: string;
};

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Produces a deliberately small HTML representation of a plain-text block.
 * It keeps paragraph breaks, line breaks, and simple Markdown-style lists
 * useful when pasting a generated draft into an email client.
 */
export function plainTextToClipboardHtml(value: string): string {
  const normalized = value.replace(/\r\n?/g, "\n").trim();
  if (!normalized) return "";

  return normalized
    .split(/\n{2,}/)
    .map((paragraph) => {
      const lines = paragraph.split("\n");
      const unorderedItems = lines.map((line) =>
        line.match(/^\s*[-*+]\s+(.+)$/),
      );
      if (unorderedItems.every(Boolean)) {
        return `<ul>${unorderedItems.map((item) => `<li>${escapeHtml(item![1])}</li>`).join("")}</ul>`;
      }

      const orderedItems = lines.map((line) =>
        line.match(/^\s*\d+[.)]\s+(.+)$/),
      );
      if (orderedItems.every(Boolean)) {
        return `<ol>${orderedItems.map((item) => `<li>${escapeHtml(item![1])}</li>`).join("")}</ol>`;
      }

      return `<p>${lines.map(escapeHtml).join("<br>")}</p>`;
    })
    .join("");
}

export async function writePlainTextToClipboard(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }

  const textarea = document.createElement("textarea");
  const selection = document.getSelection();
  const selectedRange =
    selection && selection.rangeCount > 0 ? selection.getRangeAt(0) : null;

  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.top = "-9999px";
  document.body.appendChild(textarea);
  textarea.select();

  try {
    if (!document.execCommand("copy")) {
      throw new Error("Clipboard copy failed.");
    }
  } finally {
    document.body.removeChild(textarea);
    if (selection && selectedRange) {
      selection.removeAllRanges();
      selection.addRange(selectedRange);
    }
  }
}

/**
 * Writes rich and plain MIME representations together where the browser allows
 * it. Pasting applications can select their preferred representation; older
 * browsers reliably fall back to the plain-text version.
 */
export async function writeClipboardContent(
  content: ClipboardContent,
  mode: ClipboardCopyMode = "formatted",
): Promise<void> {
  if (
    mode === "formatted" &&
    content.html &&
    navigator.clipboard?.write &&
    typeof ClipboardItem !== "undefined"
  ) {
    try {
      await navigator.clipboard.write([
        new ClipboardItem({
          "text/html": new Blob([content.html], { type: "text/html" }),
          "text/plain": new Blob([content.plainText], { type: "text/plain" }),
        }),
      ]);
      return;
    } catch {
      // Some browsers expose write() but reject HTML clipboard items. Use the
      // portable text API below rather than leaving the user without a copy.
    }
  }

  await writePlainTextToClipboard(content.plainText);
}
