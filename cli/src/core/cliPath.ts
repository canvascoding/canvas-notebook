export function resolveCliPath(env: NodeJS.ProcessEnv = process.env): string {
  return env.CANVAS_CLI_PATH || process.argv[1] || 'canvas-notebook';
}
