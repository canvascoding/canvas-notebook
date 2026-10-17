import 'server-only';

import type { AgentTool } from '@earendil-works/pi-agent-core';
import type { AgentExecutionContext } from '@/app/lib/pi/agent-execution-context';
import { readEffectiveExtensionContext } from './effective-context';
import { renderEffectiveExtensionContext } from './context-prompt';

/** Persisted foundations contain no tool recipes: final tools are known only at execution. */
export const EFFECTIVE_EXTENSION_FOUNDATION_MARKER = '<!-- canvas-effective-extension-foundation:v1 -->';

/** Only metadata from this exact issued actor/turn may become a runtime prompt. */
export function appendEffectiveExtensionContextPrompt(foundation: string, context: AgentExecutionContext,
  tools: readonly AgentTool[], query = ''): string {
  const data = readEffectiveExtensionContext(context);
  if (!data) return foundation;
  const explicitSkillRefs = data.skills.filter(skill => context.turnExtensions?.selections.some(entry => {
    const selected = entry.selection;
    return selected.kind === 'skill' && skill.package !== undefined
      && selected.package.resourceRef === skill.package.resourceRef
      && selected.package.publishedRevisionRef === skill.package.publishedRevisionRef
      && selected.package.checksum === skill.package.checksum
      && (selected.origin === 'standalone' || selected.relativeRoot === skill.package.relativeRoot);
  })).map(skill => skill.resourceId);
  const rendered = renderEffectiveExtensionContext(data, tools, query, { explicitSkillRefs });
  return `${foundation}\n\n${rendered.prompt}`;
}
