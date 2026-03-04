# Canvas Studios UI/CI Richtlinie

Diese Richtlinie definiert die visuelle Identitaet der Software und ist fuer alle neuen und bestehenden UI-Komponenten verbindlich.

## 1. Markencharakter
- Stil: technisch, praezise, klar.
- Formensprache: harte Kanten, keine Rundungen.
- Oberflaechen: kontrastreich, ruhig, ohne spielerische Effekte.
- Hierarchie: Funktion vor Dekoration.

## 2. Design Tokens (verbindlich)
- Farben immer ueber Token nutzen (`bg-primary`, `text-muted-foreground`, `border-border` usw.).
- Keine direkten Farbklassen wie `bg-blue-600`, `text-slate-300`, `bg-sky-500`.
- Primarakzent: `primary`.
- Neutrale Flaechen: `background`, `card`, `muted`.
- Warnung/Fehler: `destructive`.

## 3. Kanten und Radius
- Radius global auf `0`.
- Keine `rounded-*`-Klassen in neuen Komponenten.
- Keine kreisfoermigen Controls fuer Buttons, Chips, Badges oder Overlays.

## 4. Typografie
- Primarschrift: globale Sans-Font aus Layout.
- Monospace nur fuer Code, Terminal, Pfade.
- Ueberschriften kurz und klar, keine verspielten Schriftvarianten.
- Systemlabels und Status gern in `uppercase` mit erhoter Laufweite.

## 5. Komponentenregeln
- Buttons:
  - Primaeraktionen: `variant="default"` oder `bg-primary`.
  - Sekundaer: `variant="secondary"`/`outline`.
- Inputs/Textareas:
  - Nur Token-basierte Border- und Focus-Styles.
  - Keine lokalen `focus:ring-blue-*`-Werte.
- Status:
  - Success/Info bevorzugt ueber `primary`/`muted`.
  - Fehler ueber `destructive`.

## 6. Schatten, Tiefe, Bewegungen
- Schattierung dezent, nicht weich/glasig.
- Kein uebermaessiges Glow/Neon.
- Animationen nur funktional (Loading, Progress, Panel-Transition).

## 7. Layout und Abstaende
- 4px/8px Raster beibehalten.
- Mobile und Desktop mit gleicher visueller Sprache.
- Panels durch Border und Flaechen trennen, nicht durch starke Unschärfen.

## 8. Migration / Review-Checkliste
- Alle harten Farbwerte in Token ueberfuehrt.
- Keine Rundungen mehr sichtbar.
- Interaktive States fuer Hover/Focus/Active vorhanden.
- Hell- und Dunkelmodus getestet.
- Neue Komponenten folgen dieser Richtlinie ohne Ausnahmen.
