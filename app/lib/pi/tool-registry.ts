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
  '.svg':  'image/svg+xml',
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
      model: Type.Optional(Type.String({ description: 'Model: gemini-3.1-flash-image-preview (best quality, supports 14 reference images) or gemini-2.5-flash-image (faster, lower cost, supports 3 reference images)' })),
    }),
    execute: async (toolCallId, params) => {
      const { prompt, aspect_ratio, count, model } = params as { 
        prompt: string; 
        aspect_ratio?: string; 
        count?: number;
        model?: string;
      };
      try {
        const baseUrl = 'http://localhost:3000';
        const skillsToken = process.env.CANVAS_SKILLS_TOKEN;
        
        if (!skillsToken) {
          return {
            content: [{ type: 'text', text: 'Error: CANVAS_SKILLS_TOKEN not configured' }],
            details: { error: 'Skills token missing' },
          };
        }
        
        const response = await fetch(`${baseUrl}/api/image-generation/generate`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Canvas-Skills-Token': skillsToken,
          },
          body: JSON.stringify({
            prompt,
            aspectRatio: aspect_ratio || '1:1',
            imageCount: count || 1,
            model: model || 'gemini-3.1-flash-image-preview',
            referenceImagePaths: [],
          }),
        });
        
        const data = await response.json();
        
        if (!response.ok || !data.success) {
          return {
            content: [{ type: 'text', text: `Error: ${data.error || 'Image generation failed'}` }],
            details: { error: data.error, status: response.status },
          };
        }
        
        const results = data.data?.results || [];
        const successCount = data.data?.successCount || 0;
        const failureCount = data.data?.failureCount || 0;
        
        let resultText = `Image generation complete: ${successCount} successful, ${failureCount} failed\n\n`;
        results.forEach((result: { index: number; path?: string; mediaUrl?: string; error?: string }) => {
          if (result.path) {
            resultText += `Image ${result.index + 1}: ${result.path}\n`;
            if (result.mediaUrl) {
              resultText += `URL: ${result.mediaUrl}\n`;
            }
          } else if (result.error) {
            resultText += `Image ${result.index + 1}: Failed - ${result.error}\n`;
          }
          resultText += '\n';
        });
        
        return {
          content: [{ type: 'text', text: resultText }],
          details: data,
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
        const baseUrl = 'http://localhost:3000';
        const skillsToken = process.env.CANVAS_SKILLS_TOKEN;
        
        if (!skillsToken) {
          return {
            content: [{ type: 'text', text: 'Error: CANVAS_SKILLS_TOKEN not configured' }],
            details: { error: 'Skills token missing' },
          };
        }
        
        const response = await fetch(`${baseUrl}/api/veo/generate`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Canvas-Skills-Token': skillsToken,
          },
          body: JSON.stringify({
            prompt,
            mode: mode || 'text_to_video',
            aspectRatio: aspect_ratio || '16:9',
            resolution: resolution || '720p',
            model: 'veo-3.1-fast-generate-preview',
          }),
        });
        
        const data = await response.json();
        
        if (!response.ok || !data.success) {
          return {
            content: [{ type: 'text', text: `Error: ${data.error || 'Video generation failed'}` }],
            details: { error: data.error, status: response.status },
          };
        }
        
        const result = data.data;
        let resultText = 'Video generation started! This may take 3-10 minutes.\n\n';
        if (result?.path) {
          resultText += `Video will be saved to: ${result.path}\n`;
        }
        if (result?.mediaUrl) {
          resultText += `Media URL: ${result.mediaUrl}\n`;
        }
        
        return {
          content: [{ type: 'text', text: resultText }],
          details: data,
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
        const baseUrl = 'http://localhost:3000';
        const skillsToken = process.env.CANVAS_SKILLS_TOKEN;
        
        if (!skillsToken) {
          return {
            content: [{ type: 'text', text: 'Error: CANVAS_SKILLS_TOKEN not configured' }],
            details: { error: 'Skills token missing' },
          };
        }
        
        const response = await fetch(`${baseUrl}/api/nano-banana/localize`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Canvas-Skills-Token': skillsToken,
          },
          body: JSON.stringify({
            referenceImagePath: reference_image_path,
            targetMarkets: target_markets,
            aspectRatio: aspect_ratio || '16:9',
            model: 'gemini-3.1-flash-image-preview',
            customInstructions: instructions || '',
          }),
        });
        
        const data = await response.json();
        
        if (!response.ok || !data.success) {
          return {
            content: [{ type: 'text', text: `Error: ${data.error || 'Ad localization failed'}` }],
            details: { error: data.error, status: response.status },
          };
        }
        
        const results = data.data?.results || [];
        const successCount = data.data?.successCount || 0;
        const failureCount = data.data?.failureCount || 0;
        
        let resultText = `Ad localization complete: ${successCount} successful, ${failureCount} failed\n\n`;
        results.forEach((result: { market: string; path?: string; mediaUrl?: string; error?: string }) => {
          if (result.path) {
            resultText += `Market: ${result.market}\n`;
            resultText += `Path: ${result.path}\n`;
            if (result.mediaUrl) {
              resultText += `URL: ${result.mediaUrl}\n`;
            }
          } else if (result.error) {
            resultText += `Market: ${result.market} - Failed: ${result.error}\n`;
          }
          resultText += '\n';
        });
        
        return {
          content: [{ type: 'text', text: resultText }],
          details: data,
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
  // Workflow Automation Tools
  {
    name: 'create_automation_job',
    label: 'Creating automation job',
    description: 'Creates a new scheduled automation job. Use when user wants to automate tasks, create scheduled workflows, or set up recurring jobs. Required: name (job name), prompt (the script to execute), schedule (when to run). Schedule types: once (date+time), daily (time), weekly (days+time), interval (every+unit). Optional: preferredSkill (auto/image_generation/video_generation/ad_localization/qmd_search), targetOutputPath (where to save results), workspaceContextPaths (context files), status (active/paused).',
    parameters: Type.Object({
      name: Type.String({ description: 'Name of the automation job (max 120 chars)' }),
      prompt: Type.String({ description: 'The script/prompt to execute when the job runs' }),
      schedule: Type.Object({
        kind: Type.String({ description: 'Schedule type: once, daily, weekly, interval' }),
        date: Type.Optional(Type.String({ description: 'For once: date in YYYY-MM-DD format' })),
        time: Type.Optional(Type.String({ description: 'For daily/weekly/once: time in HH:MM format' })),
        days: Type.Optional(Type.Array(Type.String(), { description: 'For weekly: array of days (mon, tue, wed, thu, fri, sat, sun)' })),
        every: Type.Optional(Type.Number({ description: 'For interval: number of units' })),
        unit: Type.Optional(Type.String({ description: 'For interval: minutes, hours, or days' })),
        timeZone: Type.Optional(Type.String({ description: 'Timezone (default: UTC)' })),
      }),
      preferredSkill: Type.Optional(Type.String({ description: 'Skill to use: auto, image_generation, video_generation, ad_localization, qmd_search' })),
      targetOutputPath: Type.Optional(Type.String({ description: 'Where to save job outputs (relative to workspace)' })),
      workspaceContextPaths: Type.Optional(Type.Array(Type.String(), { description: 'Array of file paths to include as context' })),
      status: Type.Optional(Type.String({ description: 'Job status: active (default) or paused' })),
    }),
    execute: async (toolCallId, params) => {
      const { name, prompt, schedule, preferredSkill, targetOutputPath, workspaceContextPaths, status } = params as {
        name: string;
        prompt: string;
        schedule: {
          kind: string;
          date?: string;
          time?: string;
          days?: string[];
          every?: number;
          unit?: string;
          timeZone?: string;
        };
        preferredSkill?: string;
        targetOutputPath?: string;
        workspaceContextPaths?: string[];
        status?: string;
      };
      try {
        const workspacePath = getWorkspacePath();
        let scheduleArgs = '';
        
        switch (schedule.kind) {
          case 'once':
            scheduleArgs = `--schedule-kind once --schedule-date "${schedule.date}" --schedule-time "${schedule.time}"`;
            break;
          case 'daily':
            scheduleArgs = `--schedule-kind daily --schedule-time "${schedule.time}"`;
            break;
          case 'weekly':
            const daysStr = schedule.days?.map(d => `--schedule-days "${d}"`).join(' ') || '';
            scheduleArgs = `--schedule-kind weekly --schedule-time "${schedule.time}" ${daysStr}`;
            break;
          case 'interval':
            scheduleArgs = `--schedule-kind interval --schedule-every ${schedule.every} --schedule-unit "${schedule.unit}"`;
            break;
        }
        
        if (schedule.timeZone) {
          scheduleArgs += ` --timezone "${schedule.timeZone}"`;
        }
        
        const skillArg = preferredSkill ? `--preferred-skill "${preferredSkill}"` : '';
        const outputArg = targetOutputPath ? `--target-output "${targetOutputPath}"` : '';
        const contextArgs = workspaceContextPaths?.map(p => `--context-path "${p}"`).join(' ') || '';
        const statusArg = status ? `--status "${status}"` : '';
        
        const cmd = `/data/skills/skill workflow-automation create --name "${name}" --prompt "${prompt.replace(/"/g, '\\"')}" ${scheduleArgs} ${skillArg} ${outputArg} ${contextArgs} ${statusArg}`;
        const { stdout, stderr } = await execAsync(cmd, { cwd: workspacePath });
        return {
          content: [{ type: 'text', text: stdout || stderr || 'Automation job created successfully' }],
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
    name: 'list_automation_jobs',
    label: 'Listing automation jobs',
    description: 'Lists all automation jobs with their status and schedule information. Use when user wants to see existing automations, check job status, or view scheduled workflows.',
    parameters: Type.Object({}),
    execute: async () => {
      try {
        const workspacePath = getWorkspacePath();
        const cmd = `/data/skills/skill workflow-automation list`;
        const { stdout, stderr } = await execAsync(cmd, { cwd: workspacePath });
        return {
          content: [{ type: 'text', text: stdout || stderr || 'No automation jobs found' }],
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
    name: 'update_automation_job',
    label: 'Updating automation job',
    description: 'Updates an existing automation job. Use to modify job parameters, pause/resume jobs, change schedules, or update prompts. Required: jobId. Optional: name, prompt, schedule, preferredSkill, targetOutputPath, workspaceContextPaths, status (active/paused).',
    parameters: Type.Object({
      jobId: Type.String({ description: 'ID of the job to update' }),
      name: Type.Optional(Type.String({ description: 'New name for the job' })),
      prompt: Type.Optional(Type.String({ description: 'New prompt/script' })),
      schedule: Type.Optional(Type.Object({
        kind: Type.String({ description: 'Schedule type: once, daily, weekly, interval' }),
        date: Type.Optional(Type.String({ description: 'For once: date in YYYY-MM-DD format' })),
        time: Type.Optional(Type.String({ description: 'For daily/weekly/once: time in HH:MM format' })),
        days: Type.Optional(Type.Array(Type.String(), { description: 'For weekly: array of days' })),
        every: Type.Optional(Type.Number({ description: 'For interval: number of units' })),
        unit: Type.Optional(Type.String({ description: 'For interval: minutes, hours, or days' })),
        timeZone: Type.Optional(Type.String({ description: 'Timezone' })),
      })),
      preferredSkill: Type.Optional(Type.String({ description: 'Skill to use' })),
      targetOutputPath: Type.Optional(Type.String({ description: 'Where to save outputs' })),
      workspaceContextPaths: Type.Optional(Type.Array(Type.String(), { description: 'Context file paths' })),
      status: Type.Optional(Type.String({ description: 'active or paused' })),
    }),
    execute: async (toolCallId, params) => {
      const { jobId, name, prompt, schedule, preferredSkill, targetOutputPath, workspaceContextPaths, status } = params as {
        jobId: string;
        name?: string;
        prompt?: string;
        schedule?: {
          kind: string;
          date?: string;
          time?: string;
          days?: string[];
          every?: number;
          unit?: string;
          timeZone?: string;
        };
        preferredSkill?: string;
        targetOutputPath?: string;
        workspaceContextPaths?: string[];
        status?: string;
      };
      try {
        const workspacePath = getWorkspacePath();
        let cmd = `/data/skills/skill workflow-automation update --job-id "${jobId}"`;
        
        if (name) cmd += ` --name "${name}"`;
        if (prompt) cmd += ` --prompt "${prompt.replace(/"/g, '\\"')}"`;
        if (preferredSkill) cmd += ` --preferred-skill "${preferredSkill}"`;
        if (targetOutputPath) cmd += ` --target-output "${targetOutputPath}"`;
        if (status) cmd += ` --status "${status}"`;
        if (workspaceContextPaths?.length) {
          const contextArgs = workspaceContextPaths.map(p => `--context-path "${p}"`).join(' ');
          cmd += ` ${contextArgs}`;
        }
        
        if (schedule) {
          cmd += ` --schedule-kind "${schedule.kind}"`;
          if (schedule.date) cmd += ` --schedule-date "${schedule.date}"`;
          if (schedule.time) cmd += ` --schedule-time "${schedule.time}"`;
          if (schedule.days?.length) {
            const daysArgs = schedule.days.map(d => `--schedule-days "${d}"`).join(' ');
            cmd += ` ${daysArgs}`;
          }
          if (schedule.every) cmd += ` --schedule-every ${schedule.every}`;
          if (schedule.unit) cmd += ` --schedule-unit "${schedule.unit}"`;
          if (schedule.timeZone) cmd += ` --timezone "${schedule.timeZone}"`;
        }
        
        const { stdout, stderr } = await execAsync(cmd, { cwd: workspacePath });
        return {
          content: [{ type: 'text', text: stdout || stderr || 'Automation job updated successfully' }],
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
    name: 'delete_automation_job',
    label: 'Deleting automation job',
    description: 'Permanently deletes an automation job and all its run history. Use when user wants to remove a job completely. Required: jobId.',
    parameters: Type.Object({
      jobId: Type.String({ description: 'ID of the job to delete' }),
    }),
    execute: async (toolCallId, params) => {
      const { jobId } = params as { jobId: string };
      try {
        const workspacePath = getWorkspacePath();
        const cmd = `/data/skills/skill workflow-automation delete --job-id "${jobId}"`;
        const { stdout, stderr } = await execAsync(cmd, { cwd: workspacePath });
        return {
          content: [{ type: 'text', text: stdout || stderr || 'Automation job deleted successfully' }],
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
    name: 'trigger_automation_job',
    label: 'Triggering automation job',
    description: 'Manually triggers an automation job to run immediately, regardless of its schedule. Use when user wants to run a job now instead of waiting for the next scheduled time. Required: jobId.',
    parameters: Type.Object({
      jobId: Type.String({ description: 'ID of the job to trigger' }),
    }),
    execute: async (toolCallId, params) => {
      const { jobId } = params as { jobId: string };
      try {
        const workspacePath = getWorkspacePath();
        const cmd = `/data/skills/skill workflow-automation trigger --job-id "${jobId}"`;
        const { stdout, stderr } = await execAsync(cmd, { cwd: workspacePath });
        return {
          content: [{ type: 'text', text: stdout || stderr || 'Automation job triggered successfully' }],
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

import { getDynamicSkillTools } from '../skills/skill-tools';

export async function getPiTools(): Promise<AgentTool[]> {
  // Get static tools
  const staticTools = piTools;
  
  // Get dynamic skill tools
  try {
    const dynamicTools = await getDynamicSkillTools();
    return [...staticTools, ...dynamicTools];
  } catch (error) {
    console.error('[ToolRegistry] Error loading dynamic skills:', error);
    return staticTools;
  }
}
