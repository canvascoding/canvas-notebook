import { digest } from 'lib0/hash/sha256';
import type { MarkdownFrontmatterMode } from '../markdown/editor-document';
import type { LocalMarkdownOwnerBackend, LocalMarkdownOwnerBackendFactory } from './local-markdown-owner-contract';

function valueKey(value: string): string {
  // Fingerprints must preserve unpaired surrogates too: UTF-8 encoding replaces
  // them with U+FFFD, which would conflate distinct controlled values.
  const bytes = new Uint8Array(value.length * 2);
  for (let index = 0; index < value.length; index++) {
    const unit = value.charCodeAt(index);
    bytes[index * 2] = unit >>> 8;
    bytes[index * 2 + 1] = unit & 0xff;
  }
  return Array.from(digest(bytes), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** The controlled React value protocol and permissions live outside the views. */
export class LocalMarkdownOwnerCore<TBackend extends LocalMarkdownOwnerBackend> {
  readonly document: TBackend | null;
  private active = false;
  private focused = false;
  private sync: 'always' | 'when-blurred' = 'always';
  private seen: string;
  private accepted: string;
  private pending: string | null = null;
  private acknowledgements = new Set<string>();
  private onChange?: (markdown: string) => void;

  constructor(readonly scope: string, value: string, enabled: boolean, frontmatter: MarkdownFrontmatterMode,
    private readOnly: boolean, createBackend: LocalMarkdownOwnerBackendFactory<TBackend>) {
    this.seen = this.accepted = value;
    this.document = enabled ? createBackend({ scope, markdown: value, frontmatter,
      isWritable: () => this.active && !this.readOnly }) : null;
  }

  connect(): () => void {
    this.active = true;
    const unsubscribe = this.document?.subscribe(({ origin, snapshot }) => {
      if (origin === 'external' || origin === 'projection' || !this.active || !this.onChange) return;
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
