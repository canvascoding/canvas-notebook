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
    description: 'Idee, Kanalstruktur und Creative-Richtung fuer eine starke Social-Media-Kampagne ausarbeiten.',
    prompt:
      'Hilf mir, eine visuelle Social-Media-Kampagne fuer mein Business zu entwickeln. Erstelle ein Konzept mit Leitidee, Plattform-spezifischen Formaten, Bildsprache, Hook-Varianten, CTA-Ansatzen und einem kompakten Redaktionsplan fuer die ersten zwei Wochen.',
    icon: 'campaign',
  },
  {
    id: 'ad-creatives',
    title: 'Ad Creatives planen',
    description: 'Werbeanzeigen als konkrete Bild- und Textideen fuer mehrere Formate vorbereiten.',
    prompt:
      'Erstelle fuer mein Angebot mehrere starke Werbe-Creatives. Ich brauche unterschiedliche Angles, Visual-Ideen, Headline-Optionen, CTA-Varianten und klare Vorschlaege fuer statische Ads, Carousel-Ads und Short-Video-Anzeigen.',
    icon: 'creative',
  },
  {
    id: 'video-production',
    title: 'Video-Ideen entwickeln',
    description: 'Skript, Szenen und Produktionshinweise fuer Marketing- oder Produktvideos strukturieren.',
    prompt:
      'Hilf mir, ein kurzes Marketing- oder Produktvideo zu entwickeln. Ich moechte ein Konzept mit Ziel, Zielgruppe, Storyline, Shot-Liste, Sprechertext, On-Screen-Text und einem klaren Produktionsablauf fuer ein Video unter 45 Sekunden.',
    icon: 'video',
  },
  {
    id: 'business-strategy',
    title: 'Strategie ausarbeiten',
    description: 'Ein Business- oder Marketing-Vorhaben in Ziele, Prioritaeten und Massnahmen zerlegen.',
    prompt:
      'Arbeite mit mir eine umsetzbare Business- oder Marketing-Strategie aus. Ich brauche eine klare Struktur mit Zielbild, Positionierung, Zielgruppe, Prioritaeten, Risiken, Massnahmen fuer die naechsten 30 Tage und konkreten naechsten Schritten.',
    icon: 'strategy',
  },
  {
    id: 'document-draft',
    title: 'Dokument entwerfen',
    description: 'Ein sauberes Briefing, Angebot oder internes Dokument aufbauen und gliedern.',
    prompt:
      'Hilf mir, ein professionelles Dokument zu erstellen. Ich brauche eine sinnvolle Gliederung, klare Kapitel, Formulierungsentwuerfe und Hinweise, welche Informationen noch fehlen, damit daraus z. B. ein Briefing, Angebot oder Konzeptpapier werden kann.',
    icon: 'document',
  },
  {
    id: 'workspace-organization',
    title: 'Dateien organisieren',
    description: 'Eine produktive Ordner- und Dateistruktur fuer Projekte, Kampagnen oder Kunden aufsetzen.',
    prompt:
      'Hilf mir, meine Dateien und Projektunterlagen besser zu organisieren. Erstelle eine sinnvolle Workspace-Struktur mit Ordnerlogik, Dateibenennung, Ablage fuer Assets und Dokumente sowie einfachen Regeln, damit mein Team schneller arbeitet und weniger sucht.',
    icon: 'organize',
  },
];
