import { useLocale } from 'next-intl';

/** Local bilingual copy while the shared editor is integrated into its host surfaces. */
export function useAgentExtensionCopy() {
  const locale = useLocale();
  return (de: string, en: string) => locale.startsWith('de') ? de : en;
}
