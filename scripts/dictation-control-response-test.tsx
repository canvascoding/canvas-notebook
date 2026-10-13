import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import { NextIntlClientProvider } from 'next-intl';
import messages from '../messages/en.json';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://canvas.test/en/notebook' });
for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node', 'Event', 'DOMException'] as const) {
  Object.defineProperty(globalThis, key, { value: dom.window[key], configurable: true });
}
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { value: true, configurable: true, writable: true });

class FixtureRecorder {
  static isTypeSupported() { return true; }
  mimeType = 'audio/webm';
  ondataavailable?: (event: { data: Blob }) => void;
  onstop?: () => void;
  start() {}
  stop() {
    this.ondataavailable?.({ data: new Blob(['fixture audio'], { type: this.mimeType }) });
    this.onstop?.();
  }
}

async function main() {
  const originalFetch = globalThis.fetch;
  let stoppedTracks = 0;
  Object.defineProperty(navigator, 'mediaDevices', { value: {
    getUserMedia: async () => ({ getTracks: () => [{ stop: () => stoppedTracks++ }] }),
  }, configurable: true });
  Object.defineProperty(globalThis, 'MediaRecorder', { value: FixtureRecorder, configurable: true });
  const { render, fireEvent, cleanup } = await import('@testing-library/react');
  const { DictationControl } = await import('../app/components/canvas-agent-chat/DictationControl');
  const transcripts: string[] = [];
  let response = () => new Response('<!DOCTYPE html><html>Bad Gateway</html>', { status: 502, headers: { 'content-type': 'text/html' } });
  globalThis.fetch = async (url, init) => {
    assert.equal(url, '/api/dictation/transcribe');
    assert.equal(init?.method, 'POST');
    assert.ok(init?.body instanceof FormData);
    assert.ok(init.body.get('audio') instanceof Blob);
    return response();
  };
  try {
    const view = render(<NextIntlClientProvider locale="en" timeZone="UTC" messages={messages}>
      <DictationControl disabled={false} availability onTranscript={text => transcripts.push(text)} />
    </NextIntlClientProvider>);
    const button = view.getByTestId('chat-dictation') as HTMLButtonElement;
    const record = async () => {
      await act(async () => { fireEvent.click(button); });
      assert.equal(button.getAttribute('aria-label'), messages.dictation.stopRecording);
      await act(async () => { fireEvent.click(button); });
      assert.equal(button.disabled, false, 'failed uploads must release the recording control');
    };
    await record();
    assert.equal(view.getByRole('alert').textContent, `${messages.dictation.transcriptionError} (HTTP 502)`);
    assert.deepEqual(transcripts, [], 'an HTML gateway response never inserts text');

    response = () => Response.json({ success: false, error: 'OpenAI API quota exhausted.' }, { status: 429 });
    await record();
    assert.equal(view.getByRole('alert').textContent, 'OpenAI API quota exhausted.');
    response = () => Response.json(null, { status: 502 });
    await record();
    assert.equal(view.getByRole('alert').textContent, `${messages.dictation.transcriptionError} (HTTP 502)`);
    response = () => Response.json({ success: true, data: { text: 42 } });
    await record();
    assert.equal(view.getByRole('alert').textContent, messages.dictation.emptyTranscript);

    response = () => Response.json({ success: true, data: { text: '  Recovery transcript.  ' } });
    await record();
    assert.deepEqual(transcripts, ['Recovery transcript.']);
    assert.equal(view.queryByRole('alert'), null, 'a retry clears the earlier failure');
    assert.equal(stoppedTracks, 5, 'every completed recording releases its microphone');
    console.log('dictation-control-response-test: HTML 502, structured provider errors, malformed responses and recording retry passed');
  } finally {
    cleanup();
    globalThis.fetch = originalFetch;
    dom.window.close();
  }
}

void main().catch(error => { console.error(error); process.exitCode = 1; });
