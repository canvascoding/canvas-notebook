/** Compatibility adapter for saved jobs and older clients. Paths are instructions,
 * never an additional output or runtime-storage configuration. */
export function inlineLegacyAutomationPaths(input: {
  prompt: string;
  workspaceContextPaths?: unknown;
  targetOutputPath?: string | null;
}): string {
  const hints: string[] = [];
  if (Array.isArray(input.workspaceContextPaths)) {
    for (const path of new Set(input.workspaceContextPaths.filter((entry): entry is string => typeof entry === 'string').map((entry) => entry.trim()).filter(Boolean))) {
      hints.push(`Read the workspace path ${JSON.stringify(path)} when relevant to this task.`);
    }
  }
  if (input.targetOutputPath?.trim()) {
    hints.push(`Only if this task explicitly requires creating workspace files, use ${JSON.stringify(input.targetOutputPath.trim())} as their destination. Do not create files for run logs, metadata, or the final answer alone.`);
  }
  const missing = hints.filter((hint) => !input.prompt.includes(hint));
  return missing.length ? [input.prompt, ...missing].join('\n\n') : input.prompt;
}
