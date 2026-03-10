import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { normalizePiMessagesForLlm } from '../app/lib/pi/message-normalization';

async function main() {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'pi-attachments-'));
  const pngBytes = Buffer.from('tiny-png-payload');
  const pngBase64 = pngBytes.toString('base64');
  const filePath = path.join(tempDir, 'sample.png');

  try {
    await writeFile(filePath, pngBytes);

    const [fileMessage, dataUrlMessage, base64Message] = await normalizePiMessagesForLlm([
      {
        role: 'user',
        content: [{ type: 'image', data: filePath, mimeType: 'image/png' }],
        timestamp: Date.now(),
      },
      {
        role: 'user',
        content: [{ type: 'image', data: `data:image/png;base64,${pngBase64}`, mimeType: 'image/png' }],
        timestamp: Date.now(),
      },
      {
        role: 'toolResult',
        toolCallId: 'tool-1',
        toolName: 'screenshot',
        content: [{ type: 'image', data: pngBase64, mimeType: 'image/png' }],
        isError: false,
        timestamp: Date.now(),
      },
    ]);

    assert.deepEqual(fileMessage.content, [{ type: 'image', data: pngBase64, mimeType: 'image/png' }]);
    assert.deepEqual(dataUrlMessage.content, [{ type: 'image', data: pngBase64, mimeType: 'image/png' }]);
    assert.deepEqual(base64Message.content, [{ type: 'image', data: pngBase64, mimeType: 'image/png' }]);

    await assert.rejects(
      normalizePiMessagesForLlm([
        {
          role: 'user',
          content: [{ type: 'image', data: 'not-base64-or-a-file', mimeType: 'image/png' }],
          timestamp: Date.now(),
        },
      ]),
      /Invalid image attachment payload/,
    );

    console.log('[PI Attachment Test] Passed.');
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

void main();
