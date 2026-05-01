export interface HintDefinition {
  hintKey: string;
  page: string;
  targetSelector: string;
  mobileTargetSelector?: string;
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
      { hintKey: 'home.promptHero', page: 'home', targetSelector: '#onboarding-home-promptHero' },
      { hintKey: 'home.workspace', page: 'home', targetSelector: '#onboarding-home-workspace' },
      { hintKey: 'home.create', page: 'home', targetSelector: '#onboarding-home-create' },
    ],
  },
  notebook: {
    page: 'notebook',
    version: 1,
    hints: [
      { hintKey: 'notebook.fileBrowser', page: 'notebook', targetSelector: '#onboarding-notebook-fileBrowser' },
      { hintKey: 'notebook.editor', page: 'notebook', targetSelector: '#onboarding-notebook-editor' },
      { hintKey: 'notebook.chat', page: 'notebook', targetSelector: '#onboarding-notebook-chat' },
    ],
  },
  settings: {
    page: 'settings',
    version: 1,
    hints: [
      { hintKey: 'settings.agentSettings', page: 'settings', targetSelector: '#onboarding-settings-agentSettings', requiredTab: 'agent-settings' },
      { hintKey: 'settings.managedFiles', page: 'settings', targetSelector: '#onboarding-settings-managedFiles', requiredTab: 'agent-settings' },
      { hintKey: 'settings.tools', page: 'settings', targetSelector: '#onboarding-settings-tools', requiredTab: 'agent-settings' },
      { hintKey: 'settings.integrations', page: 'settings', targetSelector: '#onboarding-settings-integrations', requiredTab: 'integrations' },
      { hintKey: 'settings.agentsEnv', page: 'settings', targetSelector: '#onboarding-settings-env-agents', requiredTab: 'integrations' },
      { hintKey: 'settings.usage', page: 'settings', targetSelector: '#onboarding-settings-usage', requiredTab: 'usage' },
    ],
  },
  studio: {
    page: 'studio',
    version: 1,
    hints: [],
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
