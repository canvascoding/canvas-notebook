export interface HintDefinition {
  hintKey: string;
  page: string;
  targetId: string;
  mobileTargetId?: string;
  requiredTab?: string;
}

export interface PageDefinition {
  page: string;
  version: number;
  hints: HintDefinition[];
}

export const ONBOARDING_PAGES: Record<string, PageDefinition> = {
  home: {
    page: 'home',
    version: 1,
    hints: [
      { hintKey: 'home.promptHero', page: 'home', targetId: 'onboarding-home-promptHero' },
      { hintKey: 'home.workspace', page: 'home', targetId: 'onboarding-home-workspace' },
      { hintKey: 'home.create', page: 'home', targetId: 'onboarding-home-create' },
    ],
  },
  notebook: {
    page: 'notebook',
    version: 1,
    hints: [
      { hintKey: 'notebook.fileBrowser', page: 'notebook', targetId: 'onboarding-notebook-fileBrowser' },
      { hintKey: 'notebook.editor', page: 'notebook', targetId: 'onboarding-notebook-editor' },
      { hintKey: 'notebook.editorMode', page: 'notebook', targetId: 'onboarding-notebook-editorMode' },
      { hintKey: 'notebook.chat', page: 'notebook', targetId: 'onboarding-notebook-chat' },
    ],
  },
  imageGen: {
    page: 'imageGen',
    version: 1,
    hints: [
      { hintKey: 'imageGen.config', page: 'imageGen', targetId: 'onboarding-imageGen-config' },
      { hintKey: 'imageGen.references', page: 'imageGen', targetId: 'onboarding-imageGen-references' },
      { hintKey: 'imageGen.results', page: 'imageGen', targetId: 'onboarding-imageGen-results' },
    ],
  },
  veo: {
    page: 'veo',
    version: 1,
    hints: [
      { hintKey: 'veo.mode', page: 'veo', targetId: 'onboarding-veo-mode' },
      { hintKey: 'veo.config', page: 'veo', targetId: 'onboarding-veo-mode' },
      { hintKey: 'veo.results', page: 'veo', targetId: 'onboarding-veo-results' },
    ],
  },
  localizer: {
    page: 'localizer',
    version: 1,
    hints: [
      { hintKey: 'localizer.reference', page: 'localizer', targetId: 'onboarding-localizer-reference' },
      { hintKey: 'localizer.markets', page: 'localizer', targetId: 'onboarding-localizer-markets' },
      { hintKey: 'localizer.results', page: 'localizer', targetId: 'onboarding-localizer-results' },
    ],
  },
  settings: {
    page: 'settings',
    version: 1,
    hints: [
      { hintKey: 'settings.agentSettings', page: 'settings', targetId: 'onboarding-settings-agentSettings', requiredTab: 'agent-settings' },
      { hintKey: 'settings.managedFiles', page: 'settings', targetId: 'onboarding-settings-managedFiles', requiredTab: 'agent-settings' },
      { hintKey: 'settings.tools', page: 'settings', targetId: 'onboarding-settings-tools', requiredTab: 'agent-settings' },
      { hintKey: 'settings.integrations', page: 'settings', targetId: 'onboarding-settings-integrations', requiredTab: 'integrations' },
      { hintKey: 'settings.agentsEnv', page: 'settings', targetId: 'onboarding-settings-agentsEnv', requiredTab: 'integrations' },
      { hintKey: 'settings.usage', page: 'settings', targetId: 'onboarding-settings-usage', requiredTab: 'usage' },
    ],
  },
};

export const ALL_PAGES = Object.values(ONBOARDING_PAGES);
export const ALL_HINT_KEYS = ALL_PAGES.flatMap((p) => p.hints.map((h) => h.hintKey));

export function getPageDefinition(page: string): PageDefinition | undefined {
  return ONBOARDING_PAGES[page];
}

export function getHintDefinition(hintKey: string): HintDefinition | undefined {
  for (const page of ALL_PAGES) {
    const hint = page.hints.find((h) => h.hintKey === hintKey);
    if (hint) return hint;
  }
  return undefined;
}

export function getPageForHintKey(hintKey: string): string | undefined {
  const hint = getHintDefinition(hintKey);
  return hint?.page;
}