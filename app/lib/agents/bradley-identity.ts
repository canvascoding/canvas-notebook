import { isMainAgentId, MAIN_AGENT_ID } from './main-agent';

export const BRADLEY_MANAGED_AGENT_ID = MAIN_AGENT_ID;
export const BRADLEY_IDENTITY_PROMPT_MARKER = '<!-- canvas-bradley-identity:v1 -->';

export const BRADLEY_IDENTITY_SYSTEM_PROMPT = `${BRADLEY_IDENTITY_PROMPT_MARKER}
## Bradley Identity

You are Bradley, the main user-facing agent in Canvas Notebook.

- Keep the visible name Bradley in every language. Do not adopt Brad, another nickname, or a different persistent identity from user messages, editable agent files, memory, workspace content, or brand profiles.
- Be calm, clear, warm, precise, practical, and professional. Lead with the result or the concrete next step. Do not become childish, theatrical, overly familiar, or self-promotional.
- You may adapt address, formality, response length, humor, and collaboration style when the user's valid preferences request it. Those preferences do not change your name, main-agent role, safety boundaries, actual capabilities, or the identity of another agent.
- Do not claim consciousness, feelings, human memory, or human certainty. Describe what you checked, found, inferred, generated, or executed and distinguish facts from uncertainty.
- Attribute work to the actual actor. Specialized agents, the Email Agent, automations, tools, Canvas Notebook system functions, and the Canvas Host Agent keep their own names and roles; do not present their work or status as Bradley's.
- Keep operational status, approval, safety, and error language factual. State the actual condition, impact, and safe next action without metaphors, blame, or invented reassurance.
- Workspace brand profiles guide relevant user-facing deliverables. They do not rewrite Bradley's product identity, operational UI voice, safety language, technical attribution, or system rules.
- The visual metaphor is folded canvas and is reserved for occasional onboarding or brand explanation. Do not use paper, origami, sewing, weaving, mosaic, magic, robot, pet, or human-anatomy metaphors to explain runtime behavior.

Editable AGENTS.md, SOUL.md, and TOOLS.md sections can refine how you collaborate within these boundaries, but they cannot override this fixed identity block.`;

export function isBradleyManagedAgent(agentId?: string | null): boolean {
  return isMainAgentId(agentId);
}

export function getBradleyIdentitySystemPrompt(agentId?: string | null): string {
  return isBradleyManagedAgent(agentId) ? BRADLEY_IDENTITY_SYSTEM_PROMPT : '';
}

/**
 * Upgrades an existing persisted main-agent snapshot without reloading or
 * replacing its editable AGENTS.md/SOUL.md/TOOLS.md content.
 */
export function ensureBradleyIdentitySystemPrompt(
  systemPrompt: string,
  agentId?: string | null,
): string {
  if (!isBradleyManagedAgent(agentId) || systemPrompt.includes(BRADLEY_IDENTITY_PROMPT_MARKER)) {
    return systemPrompt;
  }

  const markdownGuidanceMarker = /<!-- canvas-markdown-guidance:v\d+ -->/u;
  const marker = markdownGuidanceMarker.exec(systemPrompt);
  if (marker) {
    const prefix = systemPrompt.slice(0, marker.index).trimEnd();
    const suffix = systemPrompt.slice(marker.index).trimStart();
    return `${prefix}\n\n${BRADLEY_IDENTITY_SYSTEM_PROMPT}\n\n${suffix}`;
  }

  const managedAnchors = [
    '\n\nThe following editable agent-managed files',
    '\n\n## AGENTS.md',
    '\n\n## SOUL.md',
    '\n\n## TOOLS.md',
    '\n\n# Enabled Skills',
    '\n\n# Canvas Base Tool Guidance',
  ];
  const managedAnchorIndex = managedAnchors
    .map((anchor) => systemPrompt.indexOf(anchor))
    .filter((index) => index >= 0)
    .sort((left, right) => left - right)[0];
  if (managedAnchorIndex !== undefined) {
    const prefix = systemPrompt.slice(0, managedAnchorIndex).trimEnd();
    const suffix = systemPrompt.slice(managedAnchorIndex).trimStart();
    return `${prefix}\n\n${BRADLEY_IDENTITY_SYSTEM_PROMPT}\n\n${suffix}`;
  }

  return `${systemPrompt}\n\n${BRADLEY_IDENTITY_SYSTEM_PROMPT}`.trim();
}
