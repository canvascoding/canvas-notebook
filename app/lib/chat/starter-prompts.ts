export type StarterPromptIcon =
  | 'campaign'
  | 'creative'
  | 'video'
  | 'strategy'
  | 'document'
  | 'organize';

export interface StarterPromptDefinition {
  id: string;
  title: string;
  description: string;
  prompt: string;
  icon: StarterPromptIcon;
}

export const BUSINESS_STARTER_PROMPTS: StarterPromptDefinition[] = [
  {
    id: 'sm-campaign',
    title: 'Visuelle SM-Kampagne',
    description: 'Idee, Kanalstruktur und Creative-Richtung für eine starke Social-Media-Kampagne ausarbeiten.',
    prompt:
      'Hilf mir, eine visuelle Social-Media-Kampagne für mein Business zu entwickeln. Erstelle ein Konzept mit Leitidee, plattformspezifischen Formaten, Bildsprache, Hook-Varianten, CTA-Ansätzen und einem kompakten Redaktionsplan für die ersten zwei Wochen.',
    icon: 'campaign',
  },
  {
    id: 'ad-creatives',
    title: 'Ad Creatives planen',
    description: 'Werbeanzeigen als konkrete Bild- und Textideen für mehrere Formate vorbereiten.',
    prompt:
      'Erstelle für mein Angebot mehrere starke Werbe-Creatives. Ich brauche unterschiedliche Angles, Visual-Ideen, Headline-Optionen, CTA-Varianten und klare Vorschläge für statische Ads, Carousel-Ads und Short-Video-Anzeigen.',
    icon: 'creative',
  },
  {
    id: 'video-production',
    title: 'Video-Ideen entwickeln',
    description: 'Skript, Szenen und Produktionshinweise für Marketing- oder Produktvideos strukturieren.',
    prompt:
      'Hilf mir, ein kurzes Marketing- oder Produktvideo zu entwickeln. Ich möchte ein Konzept mit Ziel, Zielgruppe, Storyline, Shot-Liste, Sprechertext, On-Screen-Text und einem klaren Produktionsablauf für ein Video unter 45 Sekunden.',
    icon: 'video',
  },
  {
    id: 'business-strategy',
    title: 'Strategie ausarbeiten',
    description: 'Ein Business- oder Marketing-Vorhaben in Ziele, Prioritäten und Maßnahmen zerlegen.',
    prompt:
      'Arbeite mit mir eine umsetzbare Business- oder Marketing-Strategie aus. Ich brauche eine klare Struktur mit Zielbild, Positionierung, Zielgruppe, Prioritäten, Risiken, Maßnahmen für die nächsten 30 Tage und konkreten nächsten Schritten.',
    icon: 'strategy',
  },
  {
    id: 'document-draft',
    title: 'Dokument entwerfen',
    description: 'Ein sauberes Briefing, Angebot oder internes Dokument aufbauen und gliedern.',
    prompt:
      'Hilf mir, ein professionelles Dokument zu erstellen. Ich brauche eine sinnvolle Gliederung, klare Kapitel, Formulierungsentwürfe und Hinweise, welche Informationen noch fehlen, damit daraus z. B. ein Briefing, Angebot oder Konzeptpapier werden kann.',
    icon: 'document',
  },
  {
    id: 'workspace-organization',
    title: 'Dateien organisieren',
    description: 'Eine produktive Ordner- und Dateistruktur für Projekte, Kampagnen oder Kunden aufsetzen.',
    prompt:
      'Hilf mir, meine Dateien und Projektunterlagen besser zu organisieren. Erstelle eine sinnvolle Workspace-Struktur mit Ordnerlogik, Dateibenennung, Ablage für Assets und Dokumente sowie einfachen Regeln, damit mein Team schneller arbeitet und weniger sucht.',
    icon: 'organize',
  },
];
