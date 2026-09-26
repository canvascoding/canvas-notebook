# Proposal-Graph: Rollout und Rücknahme

Stand: 2026-09-26. Diese Notiz beschreibt die serverseitige Graph-Policy für
FVRC-1008. Sie dokumentiert die Konfiguration, erteilt aber keine Freigabe zur
Produktionsaktivierung. Es wurden keine Produktiv- oder lokalen Runtime-Env-Dateien
geändert und kein Container neu gebaut.

## Graph-Schalter

`CANVAS_PROPOSAL_GRAPH_MODE` wird ausschließlich serverseitig ausgewertet. Der
zulässige Konfigurationsraum besteht aus genau diesen Werten:

| Wert | Wirkung |
| --- | --- |
| nicht gesetzt | Standardmäßig `off`; die lokale Entwicklungsbrücke kann greifen (siehe unten) |
| `off` | Graph-Schreibfunktionen bleiben geschlossen; Graph-Lesbarkeit und die getrennte Status-/Receipt-Recovery bleiben verfügbar |
| `canary` | Graph-Schreibfunktionen sind nur für exakt freigegebene Workspace-IDs aktiv |
| `full` | Graph-Schreibfunktionen sind für eine gültige, explizit übergebene Workspace-ID aktiv |

Groß-/Kleinschreibung wird nicht normalisiert. Ein unbekannter Wert schließt
die Policy. `off` hat Vorrang vor der lokalen Entwicklungsbrücke.

Für `canary` enthält `CANVAS_PROPOSAL_GRAPH_WORKSPACE_IDS` eine kommagetrennte
Allowlist. Ein Eintrag muss exakt dem stabilen Workspace-ID-Format
`^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$` entsprechen. Die gesamte Einstellung ist
auf 32.768 Zeichen und 256 Einträge begrenzt; leere Einträge und Wildcards sind
ungültig. Leerraum an den Rändern eines Eintrags wird entfernt. Es gibt keine
Teilstring-, Präfix- oder Musterübereinstimmung.

Eine fehlende oder ungültige Workspace-ID blockiert Graph-Schreibfunktionen
auch in `full`. Eine konfigurierte, fehlerhafte Allowlist schließt die Policy
fail-closed; eine leere Allowlist gibt keinen Canary frei. Bei `full` muss die
Workspace-ID weiterhin gültig und explizit übergeben sein. Eine konfigurierte
Allowlist wird auch dort auf Fehler geprüft.

Es gehören keine echten Workspace-IDs in dieses Repository, in Tests,
Dokumentationsbeispiele, Logs oder Tickets. Keine dieser Einstellungen enthält
Secrets. Runtime-Konfiguration gehört in die dafür vorgesehene geschützte
Umgebung und nicht in eine `.env`-Datei im Repository.

## Lokale Entwicklungsbrücke

`CANVAS_PROPOSAL_REVIEW_LOCAL_TEST=1` wirkt nur, wenn
`CANVAS_PROPOSAL_GRAPH_MODE` **nicht gesetzt** ist und `NODE_ENV` exakt
`development` oder `test` lautet. Auch dann ist eine gültige explizite
Workspace-ID erforderlich. In Produktion ist die Brücke immer geschlossen.
Ein explizites `CANVAS_PROPOSAL_GRAPH_MODE=off` überschreibt sie.

Die lokale Brücke ist kein Produktions-Rolloutmechanismus. Sie rechtfertigt
weder das Setzen eines Graph-Modus in einer Produktionsumgebung noch eine
Containerfreigabe.

## Zusammenspiel mit FVRC und Berechtigungen

Graph-Policy und FVRC-V1-Rollout sind unabhängige Gates:

- Neue Graph-Review-Aktionen benötigen zusätzlich `FILE_VERSION_CENTER_MODE`,
  dessen V1-Entscheidung `restore: true` ergibt. Das ist derzeit nur bei
  `full` der Fall; ohne Einstellung löst FVRC V1 standardmäßig ebenfalls zu
  `full` auf. `off`, `shadow` und `read_only` blockieren neue Graph-Aktionen.
- Das Graph-`off` allein schaltet den normalen FVRC-Verlauf nicht ab. Es hält
  Lesbarkeit sowie die vorhandene Status-/Receipt-Recovery offen und blockiert
  neue Graph-Freigaben und Graph-Erstellungen. Ein exakter gewöhnlicher
  Tool-Retry kann seinen bereits gespeicherten Vorschlag weiterhin lesen;
  er darf keinen zweiten Vorschlag im Legacy-Pfad erzeugen. Der normale Legacy-History- und
  Reviewpfad bleibt getrennt; Graph-`off` migriert oder ändert dort keinen
  Zustand.
- Autorisierung, Workspace-Mitgliedschaft, konkrete Datei- und Aktionsrechte,
  Session-/Actor-Prüfungen und erneute Berechtigungsprüfung bleiben zwingend.
  Ein aktiviertes Feature-Flag ersetzt keine dieser Prüfungen.

Für eine Graph-only-Rücknahme wird der Graph-Modus auf `off` gesetzt. Damit
werden keine neuen Graph-Aktionen gestartet; bereits reservierte Aktionen
bleiben über den getrennten Status-/Receipt-Endpunkt prüfbar und recoverbar.
`FILE_VERSION_CENTER_MODE` sollte für diesen gezielten Rollback nicht ebenfalls
auf `off` gesetzt werden, wenn Verlauf und Recovery verfügbar bleiben sollen.
Eine Änderung von Prozess-Environment benötigt einen Neustart beziehungsweise
eine Neuerstellung des Notebook-Prozesses. Diese Dokumentation hat keine solche
Änderung ausgeführt.

## Verifikationsstand und Freigabegrenze

Die fokussierte Policy-Unitprüfung wurde mit simulierten Prozess-Environment-Werten
ausgeführt:

- `npx tsx --conditions react-server scripts/proposal-review-capability-test.ts` — bestanden; deckt Modi, lokale Brücke, Produktionssperre, fehlende/ungültige Scopes, exakte Canary-Zuordnung sowie fehlerhafte und begrenzte Allowlists ab.
- Gezieltes ESLint für Policy-Modul und Unit-Test — bestanden.

Diese Tests prüfen die Policy-Funktion isoliert. Sie belegen keine reale
Notebook-Env-Konfiguration, keine Authentifizierung oder Rechte in einer
laufenden Umgebung, keine Canary-Workspace-Aktivierung und keinen Rollback nach
Prozessneustart. Die fokussierten Route-/Recovery- und Tool-Retry-Prüfungen sind im
[Härtungsnachweis](./evidence/fvrc-1008/hardening-progress.md) dokumentiert.
Der vollständige FVRC-1008-Rollouttest nach Serverneustart sowie eine
Produktionsaktivierung bleiben ausstehend. Kein Container
wurde neu gebaut; ein Neubau ist hier weder erfolgt noch freigegeben.

Vor einer späteren Aktivierung müssen die getrennten Auth- und Workspace-Gates,
neue Graph-Tools und Review-Aktionen, Recovery bereits reservierter Aktionen,
Graph-`off`, der Legacy-Historypfad und die Rücknahme nach Prozessneustart in
der genehmigten Zielumgebung gemeinsam verifiziert werden. Der verbindliche
Arbeitsstatus steht in [`todo.json`](./todo.json); allgemeine FVRC-V1-
Betriebsabläufe stehen in [`operations.md`](./operations.md).
