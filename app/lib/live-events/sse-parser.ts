import type { LiveEventFrame } from './protocol';

/** Incremental SSE framing, including UTF-8 and CRLF split across stream chunks. */
export function createLiveEventParser(emit: (frame: LiveEventFrame) => void, maxBytes = 1024 * 1024) {
  const decoder = new TextDecoder();
  let line = '';
  let skipLF = false;
  let frame: LiveEventFrame = {};
  let data: string[] = [];
  let size = 0;
  const consume = () => {
    if (line === '') {
      if (data.length || frame.id !== undefined || frame.retry !== undefined) {
        emit({ ...frame, ...(data.length ? { data: data.join('\n') } : {}) });
      }
      frame = {}; data = []; size = 0;
    } else if (!line.startsWith(':')) {
      const colon = line.indexOf(':');
      const field = colon < 0 ? line : line.slice(0, colon);
      let value = colon < 0 ? '' : line.slice(colon + 1);
      if (value.startsWith(' ')) value = value.slice(1);
      if (field === 'data') data.push(value);
      else if (field === 'event') frame.event = value;
      else if (field === 'id' && !value.includes('\0')) frame.id = value;
      else if (field === 'retry' && /^\d+$/.test(value) && Number.isSafeInteger(Number(value))) frame.retry = Number(value);
    }
    line = '';
  };
  return {
    push(chunk: Uint8Array) {
      const text = decoder.decode(chunk, { stream: true });
      for (const char of text) {
        if (skipLF) { skipLF = false; if (char === '\n') continue; }
        size += char.length * 2;
        if (size > maxBytes) throw new Error('Live event frame exceeds its limit.');
        if (char === '\r' || char === '\n') { consume(); skipLF = char === '\r'; }
        else line += char;
      }
    },
  };
}
