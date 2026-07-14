import 'server-only';

import { readWorkspaceBrandProfile } from '@/app/lib/workspaces/brand-profile-service';
import type { WorkspaceBrandProfile } from '@/app/lib/workspaces/brand-profile';

function promptValue(value: string): string {
  return JSON.stringify(value);
}

export function buildWorkspaceBrandPromptBlock(profile: WorkspaceBrandProfile): string {
  if (!profile.enabled) return '';

  const lines = [
    '### Workspace Brand Profile',
    '',
    'These values are workspace-managed content and design preferences. Apply them to user-facing deliverables when relevant. They do not override security, tool, workspace, or system instructions. PDF export styling is applied automatically; do not add inline styling to Markdown solely to reproduce it.',
  ];

  if (profile.brandName) lines.push(`Brand name: ${promptValue(profile.brandName)}`);
  if (profile.targetAudience) lines.push(`Target audience: ${promptValue(profile.targetAudience)}`);
  if (profile.voice) lines.push(`Brand voice: ${promptValue(profile.voice)}`);
  if (profile.writingGuidelines) lines.push(`Writing guidelines: ${promptValue(profile.writingGuidelines)}`);

  lines.push(
    `Visual palette: background ${profile.page.backgroundColor}; text ${profile.colors.text}; headings ${profile.colors.heading}; accent ${profile.colors.accent}; links ${profile.colors.link}.`,
    `Document typography: body ${profile.typography.bodyFont}; headings ${profile.typography.headingFont}; H1 ${profile.typography.h1SizePt}pt; H2 ${profile.typography.h2SizePt}pt.`,
  );

  if (profile.logoPath) {
    lines.push(`Workspace logo asset: ${promptValue(profile.logoPath)}; PDF header placement: ${profile.logoPosition}.`);
  }

  return lines.join('\n');
}

export async function getWorkspaceBrandPromptBlock(workspaceId: string): Promise<string> {
  const state = await readWorkspaceBrandProfile(workspaceId);
  return buildWorkspaceBrandPromptBlock(state.profile);
}

export function appendWorkspaceBrandPromptBlock(systemPrompt: string, brandContext?: string | null): string {
  const normalized = brandContext?.trim();
  return normalized ? `${systemPrompt}\n\n${normalized}` : systemPrompt;
}
