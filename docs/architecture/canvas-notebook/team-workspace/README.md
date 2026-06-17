# Canvas Notebook Team Workspace

Stand: 2026-06-17

Dieses Verzeichnis ist der zentrale Arbeitsbereich fuer den Team-Workspace-Umbau in Canvas Notebook.

## Dateien

- `00-full-plan.md`: vollstaendiger Plan aus der Control-Plane-Abstimmung, unverkuerzt abgelegt.
- `01-inventory.md`: Ist-Inventar der aktuellen Datei-, Workspace- und Scope-Annahmen in diesem Repository.
- `02-execution-model.md`: Vorgehensmodell mit Unterprojekten, Reihenfolge, Commit-Strategie und Test-Gates.
- `03-scope-matrix.md`: Ziel-Scope-Matrix fuer bestehende Funktionen.
- `04-auth-roles-model.md`: Better-Auth-basiertes Organization-, Rollen- und Permission-Modell.
- `../todo.json`: Aufgabenindex fuer Agenten und Fortschrittsverfolgung.

## Arbeitsregeln

- Nur ein Unterprojekt gleichzeitig aktiv bearbeiten.
- Keine UI bauen, bevor die serverseitige Isolation fuer den betroffenen Scope steht.
- Jede relevante Aenderung bekommt eigene Tests oder eine bewusst dokumentierte Testluecke.
- Vor Container-Builds immer `npm run build`.
- Container nur bauen, wenn es explizit gefordert ist.
- Fuer UI-Pruefungen vor Playwright/Browser-Automation explizit bestaetigen lassen, sofern die Aufgabe es nicht bereits verlangt.
- Nach abgeschlossenen sinnvollen Zwischenschritten committen, aber nicht pushen.

## Aktueller Stand

- Schritt 1 ist abgeschlossen: Ist-Inventar erstellt.
- Schritt 2 ist abgeschlossen: Scope-Matrix erstellt.
- Schritt 3 ist abgeschlossen: Rollenmodell festgelegt.
- Naechster Schritt: Initiales Admin-/Owner-Setup und Admin-only Gates absichern.
