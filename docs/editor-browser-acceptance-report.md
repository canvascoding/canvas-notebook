# Browserabnahme: Blockbearbeitung und Lifecycle

Begonnen am 9. September 2026 nach Browserfreigabe. Ausgangsstand `1a3ed752`, Chromium `149.0.7827.55`, Desktop 1600 × 900. Der aktuelle Worktree läuft als Host-Dev-Server auf Port 3000 am verwalteten lokalen PostgreSQL-Stack. Zwei verschiedene Nutzer sind angemeldet und haben Schreibrechte im `Shared Test Workspace`. Kein Container wurde gebaut.

Der [Abnahmeablauf](editor-browser-acceptance-runbook.md) bleibt die vollständige Prüfliste. Dieser Bericht dokumentiert ausgeführte Fälle und ist noch keine Gesamtfreigabe.

## Erststart einer neuen Datei

**Gefunden:** Eine neue leere Markdown-Datei zeigte eine bestätigte Verbindung und einen aktuellen Checkpoint, aber zugleich „This live state cannot currently be rendered“. Der Browserzustand enthielt sowohl `body` als auch `canvas-block-tree-v1`; die heruntergeladene Binärsicherung enthielt nur den gültigen Blockbaum.

**Ursache und Korrektur:** Die Live-Vorschau las nach dem ersten, leeren IndexedDB-Ladevorgang den noch nicht eingetroffenen Blockbaum als altes XML. Dadurch legte sie selbst einen konkurrierenden `body`-Root an. Sie wartet jetzt bei einer angekündigten Block-Repräsentation auf deren tatsächlichen Root. Der Update-Listener bleibt aktiv und veröffentlicht die erste Serverprojektion ohne einen Ansichtswechsel.

**Nachgewiesen:** Der ergänzte Regressionstest scheiterte vor der Korrektur mit drei unerwarteten Roots statt null und besteht danach. Live-Markdown-, Startup-Recovery- und Structure-Recovery-Suites sowie ESLint bestehen. Im Browser wurde anschließend eine weitere neue Datei angelegt, normal per Tastatur bearbeitet, bis zum bestätigten Checkpoint gewartet und neu geladen. Der eingegebene Text war wieder sichtbar und editierbar; es gab keine Browser-Exceptions.

Private Laufartefakte liegen unter `~/.codex/tmp/editor-fbd6-browser-20260909/`: QA-Inventar, Vorher-/Nachher-Screenshots, Binärsicherung und ein JSON-Nachweis mit Dokument-/Block-ID. Zugangsdaten und Transporttickets werden nicht in den Bericht übernommen.

## Noch auszuführen

Die zehn Abnahmegruppen, die getrennten Clipboard-/IME-/Touch-Prüfungen und Browser-Latenzmessungen sind hier noch nicht als bestanden bewertet.
