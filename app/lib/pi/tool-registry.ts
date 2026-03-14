import { type AgentTool } from '@mariozechner/pi-agent-core';
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

type CommandExecutionError = Error & {
  code?: number;
  stdout?: string;
  stderr?: string;
};

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Unknown tool error';
}

function asCommandExecutionError(error: unknown): CommandExecutionError {
  return error instanceof Error ? (error as CommandExecutionError) : new Error(String(error));
}

/**
 * Registry for PI-compatible tools.
 */

export const piTools: AgentTool[] = [
  {
    name: 'ls',
    label: 'Listing directory',
    description: 'Lists files and directories in the workspace.',
    parameters: Type.Object({
      path: Type.Optional(Type.String({ description: 'The path to list. Defaults to root.' })),
    }),
    execute: async (toolCallId, params) => {
      try {
        const { path: dirPath } = params as { path?: string };
        const files = await listDirectory(dirPath || '.');
        const content = files.map(f => `${f.type === 'directory' ? '[DIR] ' : ''}${f.path}`).join('\n');
        return {
          content: [{ type: 'text', text: content || '(empty)' }],
          details: { files },
        };
      } catch (error: unknown) {
        const message = getErrorMessage(error);
        return {
          content: [{ type: 'text', text: `Error: ${message}` }],
          details: { error: message },
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
    execute: async (toolCallId, params) => {
      const { path: filePath } = params as { path: string };
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
      } catch (error: unknown) {
        const message = getErrorMessage(error);
        return {
          content: [{ type: 'text', text: `Error: ${message}` }],
          details: { error: message },
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
    execute: async (toolCallId, params) => {
      const { path: filePath, content } = params as { path: string; content: string };
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
      } catch (error: unknown) {
        const message = getErrorMessage(error);
        return {
          content: [{ type: 'text', text: `Error: ${message}` }],
          details: { error: message },
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
    execute: async (toolCallId, params) => {
      const { command } = params as { command: string };
      try {
        const workspacePath = getWorkspacePath();
        const { stdout, stderr } = await execAsync(command, { cwd: workspacePath });
        const output = [stdout, stderr].filter(Boolean).join('\n');
        return {
          content: [{ type: 'text', text: output || '(no output)' }],
          details: { stdout, stderr },
        };
      } catch (error: unknown) {
        const execError = asCommandExecutionError(error);
        const output = [execError.stdout, execError.stderr, execError.message].filter(Boolean).join('\n');
        return {
          content: [{ type: 'text', text: output }],
          details: { error: execError.message, stdout: execError.stdout, stderr: execError.stderr },
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
    execute: async (toolCallId, params) => {
      const { pattern, path: searchPath } = params as { pattern: string; path?: string };
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
      } catch (error: unknown) {
        const execError = asCommandExecutionError(error);
        if (execError.code === 1) {
          return { content: [{ type: 'text', text: '(no matches found)' }], details: { stdout: '', stderr: '' } };
        }
        const message = execError.message;
        return {
          content: [{ type: 'text', text: `Error: ${message}` }],
          details: { error: message },
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
    execute: async (toolCallId, params) => {
      const { pattern } = params as { pattern: string };
      try {
        const workspacePath = getWorkspacePath();
        const command = `find . -name "${pattern.replace(/"/g, '\\"')}"`;
        const { stdout, stderr } = await execAsync(command, { cwd: workspacePath });
        return {
          content: [{ type: 'text', text: stdout || '(no matches found)' }],
          details: { stdout, stderr },
        };
      } catch (error: unknown) {
        const message = getErrorMessage(error);
        return {
          content: [{ type: 'text', text: `Error: ${message}` }],
          details: { error: message },
        };
      }
    },
  },
  // Canvas Notebook Skills
  {
    name: 'image_generation',
    label: 'Generating images',
    description: 'Generates images using Gemini Image Generation. Use when user asks for: image creation, picture generation, "create an image of...", "generate a photo". Output: workspace/image-generation/generations/. Requires GEMINI_API_KEY in settings.',
    parameters: Type.Object({
      prompt: Type.String({ description: 'Text description of the image to generate' }),
      aspect_ratio: Type.Optional(Type.String({ description: 'Aspect ratio: 16:9, 1:1, 9:16, 4:3, 3:4. Default: 1:1' })),
      count: Type.Optional(Type.Number({ description: 'Number of images to generate (1-4). Default: 1' })),
      model: Type.Optional(Type.String({ description: 'Model: gemini-3.1-flash-image-preview (default) or gemini-2.5-flash-image-preview' })),
    }),
    execute: async (toolCallId, params) => {
      const { prompt, aspect_ratio, count, model } = params as { 
        prompt: string; 
        aspect_ratio?: string; 
        count?: number;
        model?: string;
      };
      try {
        const workspacePath = getWorkspacePath();
        const cmd = `/data/skills/skill image-generation --prompt "${prompt.replace(/"/g, '\\"')}"${aspect_ratio ? ` --aspect-ratio "${aspect_ratio}"` : ''}${count ? ` --count ${count}` : ''}${model ? ` --model "${model}"` : ''}`;
        const { stdout, stderr } = await execAsync(cmd, { cwd: workspacePath });
        return {
          content: [{ type: 'text', text: stdout || stderr || 'Image generation started' }],
          details: { stdout, stderr },
        };
      } catch (error: unknown) {
        const message = getErrorMessage(error);
        return {
          content: [{ type: 'text', text: `Error: ${message}` }],
          details: { error: message },
        };
      }
    },
  },
  {
    name: 'video_generation',
    label: 'Generating videos',
    description: 'Generates videos using Google VEO. Use when user asks for: video creation, "create a video of...", "generate a video". Output: workspace/veo-studio/video-generation/. Requires GEMINI_API_KEY in settings. Note: Takes 3-10 minutes.',
    parameters: Type.Object({
      prompt: Type.String({ description: 'Text description of the video to generate' }),
      mode: Type.Optional(Type.String({ description: 'Mode: text_to_video (default), frames_to_video, references_to_video, extend_video' })),
      aspect_ratio: Type.Optional(Type.String({ description: 'Aspect ratio: 16:9 or 9:16. Default: 16:9' })),
      resolution: Type.Optional(Type.String({ description: 'Resolution: 720p (default), 1080p, 4k' })),
    }),
    execute: async (toolCallId, params) => {
      const { prompt, mode, aspect_ratio, resolution } = params as { 
        prompt: string; 
        mode?: string; 
        aspect_ratio?: string;
        resolution?: string;
      };
      try {
        const workspacePath = getWorkspacePath();
        const cmd = `/data/skills/skill video-generation --prompt "${prompt.replace(/"/g, '\\"')}"${mode ? ` --mode "${mode}"` : ''}${aspect_ratio ? ` --aspect-ratio "${aspect_ratio}"` : ''}${resolution ? ` --resolution "${resolution}"` : ''}`;
        const { stdout, stderr } = await execAsync(cmd, { cwd: workspacePath });
        return {
          content: [{ type: 'text', text: stdout || stderr || 'Video generation started (this may take 3-10 minutes)' }],
          details: { stdout, stderr },
        };
      } catch (error: unknown) {
        const message = getErrorMessage(error);
        return {
          content: [{ type: 'text', text: `Error: ${message}` }],
          details: { error: message },
        };
      }
    },
  },
  {
    name: 'ad_localization',
    label: 'Localizing ads',
    description: 'Localizes ad images for target markets using Gemini. Preserves layout, typography, and visual design - translates only the text. Use when user asks for: "localize this ad", "translate for market...", "adapt for country...". Output: workspace/nano-banana-ad-localizer/localizations/. Requires GEMINI_API_KEY in settings.',
    parameters: Type.Object({
      reference_image_path: Type.String({ description: 'Path to reference image (must be under nano-banana-ad-localizer/)' }),
      target_markets: Type.Array(Type.String(), { description: 'List of target markets (e.g., ["Germany", "France", "Japan"])' }),
      aspect_ratio: Type.Optional(Type.String({ description: 'Aspect ratio: 16:9, 1:1, 9:16, 4:3, 3:4. Default: 16:9' })),
      instructions: Type.Optional(Type.String({ description: 'Additional localization instructions' })),
    }),
    execute: async (toolCallId, params) => {
      const { reference_image_path, target_markets, aspect_ratio, instructions } = params as { 
        reference_image_path: string; 
        target_markets: string[];
        aspect_ratio?: string;
        instructions?: string;
      };
      try {
        const workspacePath = getWorkspacePath();
        let cmd = `/data/skills/skill ad-localization --ref "${reference_image_path.replace(/"/g, '\\"')}"`;
        target_markets.forEach(market => {
          cmd += ` --market "${market.replace(/"/g, '\\"')}"`;
        });
        if (aspect_ratio) cmd += ` --aspect-ratio "${aspect_ratio}"`;
        if (instructions) cmd += ` --instructions "${instructions.replace(/"/g, '\\"')}"`;
        
        const { stdout, stderr } = await execAsync(cmd, { cwd: workspacePath });
        return {
          content: [{ type: 'text', text: stdout || stderr || 'Ad localization started' }],
          details: { stdout, stderr },
        };
      } catch (error: unknown) {
        const message = getErrorMessage(error);
        return {
          content: [{ type: 'text', text: `Error: ${message}` }],
          details: { error: message },
        };
      }
    },
  },
  {
    name: 'qmd_search',
    label: 'Searching markdown notes',
    description: 'Searches markdown notes and documents in the workspace using qmd. Automatically indexes all .md files in /data/workspace. Use when user asks for: "search my notes", "find related documents", "search in my workspace". Prefer qmd search (fast keyword search) over vsearch (semantic, slower).',
    parameters: Type.Object({
      query: Type.String({ description: 'Search query' }),
      mode: Type.Optional(Type.String({ description: 'Search mode: search (fast keyword, default), vsearch (semantic, slower), query (hybrid)' })),
      collection: Type.Optional(Type.String({ description: 'Collection to search. Default: workspace' })),
      limit: Type.Optional(Type.Number({ description: 'Maximum number of results. Default: 10' })),
    }),
    execute: async (toolCallId, params) => {
      const { query, mode, collection, limit } = params as { 
        query: string; 
        mode?: string;
        collection?: string;
        limit?: number;
      };
      try {
        const workspacePath = getWorkspacePath();
        const searchMode = mode || 'search';
        let cmd = `export PATH="$HOME/.bun/bin:$PATH" && qmd ${searchMode} "${query.replace(/"/g, '\\"')}"`;
        if (collection) cmd += ` -c "${collection}"`;
        if (limit) cmd += ` -n ${limit}`;
        
        const { stdout, stderr } = await execAsync(cmd, { cwd: workspacePath });
        return {
          content: [{ type: 'text', text: stdout || stderr || 'Search completed' }],
          details: { stdout, stderr },
        };
      } catch (error: unknown) {
        const message = getErrorMessage(error);
        return {
          content: [{ type: 'text', text: `Error: ${message}` }],
          details: { error: message },
        };
      }
    },
  },
];

export function getPiTools(): AgentTool[] {
  return piTools;
}
