import { digest } from 'lib0/hash/sha256';
import { LocalMarkdownDocument } from './local-markdown-document';
import type { MarkdownFrontmatterMode } from '../markdown/editor-document';

function valueKey(value: string): string {
  return Array.from(digest(new TextEncoder().encode(value)), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** The controlled React value protocol and permissions live outside the views. */
export class LocalMarkdownOwner {
  readonly document: LocalMarkdownDocument | null;
  private active = false;
  private focused = false;
  private sync: 'always' | 'when-blurred' = 'always';
  private seen: string;
  private accepted: string;
  private pending: string | null = null;
  private acknowledgements = new Set<string>();
  private onChange?: (markdown: string) => void;

  constructor(readonly scope: string, value: string, enabled: boolean, frontmatter: MarkdownFrontmatterMode, private readOnly: boolean) {
    this.seen = this.accepted = value;
    this.document = enabled ? new LocalMarkdownDocument(value, frontmatter, () => this.active && !this.readOnly) : null;
  }

  connect(): () => void {
    this.active = true;
    const unsubscribe = this.document?.subscribe(({ origin, snapshot }) => {
      if (origin === 'external' || !this.active || !this.onChange) return;
      // A parent may acknowledge an earlier edit after a newer one. Bounded
      // fingerprints avoid retaining many copies of a large document.
      this.acknowledgements.add(valueKey(snapshot.markdown));
      if (this.acknowledgements.size > 128) this.acknowledgements.delete(this.acknowledgements.values().next().value!);
      this.onChange(snapshot.markdown);
    });
    return () => { this.active = false; unsubscribe?.(); };
  }

  update(value: string, readOnly: boolean, sync: 'always' | 'when-blurred', onChange?: (markdown: string) => void): void {
    this.readOnly = readOnly;
    this.sync = sync;
    this.onChange = onChange;
    if (!this.document) return;
    if (value === this.document.getSnapshot().markdown) {
      this.accepted = value;
      this.pending = null;
      this.acknowledgements.delete(valueKey(value));
    } else if (this.seen !== value) {
      if (!this.acknowledgements.delete(valueKey(value))) this.pending = value;
    }
    this.seen = value;
    this.flushExternal();
  }

  setFocused(focused: boolean): void {
    this.focused = focused;
    if (!focused) this.flushExternal();
  }

  private flushExternal(): void {
    if (!this.active || !this.document || this.pending === null) return;
    if (this.sync === 'when-blurred' && !this.readOnly && this.focused
      && this.document.getSnapshot().markdown !== this.accepted) return;
    const next = this.pending;
    this.pending = null;
    this.accepted = next;
    this.acknowledgements.clear();
    this.document.replaceExternal(next);
  }
}
