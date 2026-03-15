function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'automation';
}

export function slugifyAutomationName(value: string): string {
  return slugify(value);
}

export function getDefaultAutomationTargetOutputPath(name: string): string {
  return `automationen/${slugifyAutomationName(name)}/output`;
}

export function getEffectiveAutomationTargetOutputPath(input: {
  name: string;
  targetOutputPath?: string | null;
}): string {
  const candidate = typeof input.targetOutputPath === 'string' ? input.targetOutputPath.trim() : '';
  return candidate || getDefaultAutomationTargetOutputPath(input.name);
}
