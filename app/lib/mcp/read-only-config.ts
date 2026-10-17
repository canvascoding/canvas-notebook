import 'server-only';

import { constants } from 'node:fs';
import fs from 'node:fs/promises';
import { parseAndValidateMcpConfig, type McpConfig } from './config';

/** Caller-owned metadata read: never creates, repairs, hydrates or migrates configuration. */
export async function readExistingConfig(filePath: string): Promise<McpConfig> {
  let initial;
  try { initial = await fs.lstat(filePath); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { mcpServers: {} }; throw error; }
  if (!initial.isFile() || initial.isSymbolicLink() || initial.size > 2 * 1024 * 1024) throw new Error('Invalid MCP inventory file.');
  const file = await fs.open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = await file.stat();
    if (opened.dev !== initial.dev || opened.ino !== initial.ino || opened.size > 2 * 1024 * 1024) throw new Error('Changed MCP inventory file.');
    const buffer = Buffer.alloc(2 * 1024 * 1024 + 1);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    if (bytesRead > 2 * 1024 * 1024) throw new Error('MCP inventory file exceeds its size bound.');
    return parseAndValidateMcpConfig(buffer.subarray(0, bytesRead).toString('utf8'));
  } finally { await file.close(); }
}
