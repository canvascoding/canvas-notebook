import { type AgentTool, type AgentToolResult } from '@mariozechner/pi-agent-core';
import { type ImageContent } from '@mariozechner/pi-ai';
import { Type } from '@sinclair/typebox';
import { listDirectory, readFile, writeFile, createDirectory } from '../filesystem/workspace-files';
import { exec } from 'child_process';
import { promisify } from 'util';
import { getWorkspacePath } from '../utils/workspace-manager';
import path from 'path';

const execAsync = promisify(exec);

const IMAGE_EXTENSIONS: Record<string, string> = {
  '.gif':  'image/gif',
  '.jpeg': 'image/jpeg',
  '.jpg':  'image/jpeg',
  '.png':  'image/png',
  '.webp': 'image/webp',
};

function imageContentForBuffer(filePath: string, buffer: Buffer): ImageContent | null {
  const mimeType = IMAGE_EXTENSIONS[path.extname(filePath).toLowerCase()];
  if (!mimeType) return null;
  return { type: 'image', data: buffer.toString('base64'), mimeType };
}

/**
 * Registry for PI-compatible tools.
 */

export const piTools: AgentTool<any>[] = [
  {
    name: 'ls',
    label: 'Listing directory',
    description: 'Lists files and directories in the workspace.',
    parameters: Type.Object({
      path: Type.Optional(Type.String({ description: 'The path to list. Defaults to root.' })),
    }),
    execute: async (toolCallId, { path: dirPath }) => {
      try {
        const files = await listDirectory(dirPath || '.');
        const content = files.map(f => `${f.type === 'directory' ? '[DIR] ' : ''}${f.path}`).join('\n');
        return {
          content: [{ type: 'text', text: content || '(empty)' }],
          details: { files },
        };
      } catch (error: any) {
        return {
          content: [{ type: 'text', text: `Error: ${error.message}` }],
          details: { error: error.message },
        };
      }
    },
  },
  {
    name: 'read',
    label: 'Reading file',
    description: 'Reads the content of a file in the workspace.',
    parameters: Type.Object({
      path: Type.String({ description: 'The path to the file to read.' }),
    }),
    execute: async (toolCallId, { path: filePath }) => {
      try {
        const buffer = await readFile(filePath);
        const image = imageContentForBuffer(filePath, buffer);
        if (image) {
          return {
            content: [image],
            details: { filePath, size: buffer.length, type: 'image' },
          };
        }
        return {
          content: [{ type: 'text', text: buffer.toString('utf8') }],
          details: { filePath, size: buffer.length },
        };
      } catch (error: any) {
        return {
          content: [{ type: 'text', text: `Error: ${error.message}` }],
          details: { error: error.message },
        };
      }
    },
  },
  {
    name: 'write',
    label: 'Writing file',
    description: 'Writes content to a file in the workspace. Creates directories if they do not exist.',
    parameters: Type.Object({
      path: Type.String({ description: 'The path to the file to write.' }),
      content: Type.String({ description: 'The content to write.' }),
    }),
    execute: async (toolCallId, { path: filePath, content }) => {
      try {
        const dir = path.dirname(filePath);
        if (dir !== '.') {
          await createDirectory(dir);
        }
        await writeFile(filePath, content);
        return {
          content: [{ type: 'text', text: `Successfully wrote ${content.length} bytes to ${filePath}` }],
          details: { filePath, size: content.length },
        };
      } catch (error: any) {
        return {
          content: [{ type: 'text', text: `Error: ${error.message}` }],
          details: { error: error.message },
        };
      }
    },
  },
  {
    name: 'bash',
    label: 'Executing command',
    description: 'Executes a bash command in the workspace.',
    parameters: Type.Object({
      command: Type.String({ description: 'The command to execute.' }),
    }),
    execute: async (toolCallId, { command }) => {
      try {
        const workspacePath = getWorkspacePath();
        const { stdout, stderr } = await execAsync(command, { cwd: workspacePath });
        const output = [stdout, stderr].filter(Boolean).join('\n');
        return {
          content: [{ type: 'text', text: output || '(no output)' }],
          details: { stdout, stderr },
        };
      } catch (error: any) {
        const output = [error.stdout, error.stderr, error.message].filter(Boolean).join('\n');
        return {
          content: [{ type: 'text', text: output }],
          details: { error: error.message, stdout: error.stdout, stderr: error.stderr },
        };
      }
    },
  },
  {
    name: 'grep',
    label: 'Searching files',
    description: 'Searches for a pattern in files within the workspace.',
    parameters: Type.Object({
      pattern: Type.String({ description: 'The regex pattern to search for.' }),
      path: Type.Optional(Type.String({ description: 'The directory or file to search in. Defaults to root.' })),
    }),
    execute: async (toolCallId, { pattern, path: searchPath }) => {
      try {
        const workspacePath = getWorkspacePath();
        const targetPath = searchPath || '.';
        // Use ripgrep (rg) if available, otherwise fallback to grep
        const command = `rg -n "${pattern.replace(/"/g, '\\"')}" ${targetPath} || grep -rnE "${pattern.replace(/"/g, '\\"')}" ${targetPath}`;
        const { stdout, stderr } = await execAsync(command, { cwd: workspacePath });
        const output = [stdout, stderr].filter(Boolean).join('\n');
        return {
          content: [{ type: 'text', text: output || '(no matches found)' }],
          details: { stdout, stderr },
        };
      } catch (error: any) {
        if (error.code === 1) { // No matches
          return { content: [{ type: 'text', text: '(no matches found)' }], details: { stdout: '', stderr: '' } };
        }
        return {
          content: [{ type: 'text', text: `Error: ${error.message}` }],
          details: { error: error.message },
        };
      }
    },
  },
  {
    name: 'glob',
    label: 'Finding files',
    description: 'Finds files matching a glob pattern.',
    parameters: Type.Object({
      pattern: Type.String({ description: 'The glob pattern (e.g., "**/*.ts").' }),
    }),
    execute: async (toolCallId, { pattern }) => {
      try {
        const workspacePath = getWorkspacePath();
        const command = `find . -name "${pattern.replace(/"/g, '\\"')}"`;
        const { stdout, stderr } = await execAsync(command, { cwd: workspacePath });
        return {
          content: [{ type: 'text', text: stdout || '(no matches found)' }],
          details: { stdout, stderr },
        };
      } catch (error: any) {
        return {
          content: [{ type: 'text', text: `Error: ${error.message}` }],
          details: { error: error.message },
        };
      }
    },
  },
];

export function getPiTools(): AgentTool<any>[] {
  return piTools;
}
