# FVRC-1005 Timeline-, Compare- und API-Projektionsnachweis

Datum: 21. September 2026

## Ergebnis

FVRC-1005 stellt den Proposal-Graph als permission-aware, versionierten Lese- und
Compare-Vertrag bereit. Die sichtbare Auswertung wird immer gegen den aktuellen
autoritativen Dokumentstand erzeugt. Einzel- und Closure-Auswahl, Graphrevision,
Current-Proof, Kandidaten-Hash und Selection-Hash bleiben bis zur spaeteren Aktion
gebunden; eine veraenderte oder ungezeigte Auswahl erzeugt keine Freigabe.

Der produktive Leseweg loest Root, Parent, Relation, Actionability, terminale
Referenzen und erlaubte Aktionen nur innerhalb des autorisierten Workspace-Scope
auf. Read-only darf zulaessige Projektionen und Vergleiche lesen, aber keine
Graphmutation ausloesen. Fremde Initiatoren, verlorene Berechtigungen,
Cross-Workspace-Referenzen und unvollstaendige Closure bleiben fail-closed.

Der Compare-Endpunkt verwendet denselben mehrstelligen Text-Diff wie die bestehende
Versionsansicht, jedoch auf dem erneut autorisierten, unveraenderlichen
Proposal-Kandidaten. `empty_effect` und `satisfied_elsewhere` sind explizite
Nullwirkungszustaende; fehlender Inhalt, echte Ueberlappung und unbewiesene
Legacy-Patches werden nicht als `+0/-0` oder anwendbar dargestellt.

## Harness und reproduzierbare Regression

Das deterministische Zehn-Vorschlaege-Fixture besitzt stabile IDs und erwartete
Einzel-/Batchresultate. Der gemeinsame Managed-Testkontext verwendet je Origin und
Identitaet einen geprueften Auth-Zustand, getrennte Admin-/Mitglied-Kontexte sowie
das feste Team-Workspace-Fixture. Ein Test meldet HTTP 429 mit Methode und URL,
anstatt nur eine generische Browsermeldung zu hinterlassen.

Der erste Gesamtlauf belegte zwei voneinander getrennte Harness-Grenzen:

- Wiederholtes Passwort-Login in neu erzeugten Browserkontexten fuellte das
  Login-Budget. Die Collaboration-Suite verwendet jetzt den gemeinsamen
  authentifizierten Kontext und prueft eine vorhandene Session vor einem Fallback-Login.
- Mehrere grosse UI-Suites beziehungsweise fuenf Collaboration-Szenarien teilten
  den In-Memory-Bucket von `GET /api/markdown/link-index`. Der Managed Runner kann
  deshalb vor jedem unabhaengigen Lauf einen shell-freien Reset ausfuehren und
  prueft danach Health, PostgreSQL-Teammodus und Build-ID erneut. Die
  Collaboration-Szenarien laufen getrennt; Produktions-Ratenlimits bleiben
  unveraendert aktiv.

Fehler enthalten einen auf 6.000 Zeichen begrenzten, ANSI-bereinigten
Playwright-Output-Tail. Ein fehlgeschlagener Reset stoppt vor Playwright. Pflicht-
Skips und jede 429-Ausgabe bleiben harte Gates.

## Verifikation

- `npm run test:proposal-graph:review-projection`: Fixture-, Auswertungs-,
  Legacy-, Projection-, API-, Read-Service-, Route-Error-, Compare-, Runtime-,
  bestehende Compare-Regression und Managed-Runner-Tests bestanden.
- `npx tsc --noEmit`, fokussiertes ESLint und `git diff --check`: bestanden.
- Produktionsbuild mit `NODE_ENV=production`: 346 Seiten, bestanden.
- Einziger verwalteter lokaler Team-Seat-Stack mit PostgreSQL, Teamlizenz,
  zwei Fixture-Nutzern und `Shared Test Workspace`: Build/Recreate, Login,
  Health und Build-Identitaet bestanden.
- Managed Browser-Gate mit genau einem Worker: sieben Szenarien jeweils zweimal,
  insgesamt 14 serielle Suite-Laeufe bestanden. Enthalten waren das globale
  Versionscenter, Agent-Review-Lifecycle, Join-Navigation, Blockoperationen,
  Caret-/Viewport-Layout, Mehrclient-Konvergenz und echte Agent-Tool-Reviews.
- Kein Pflichtlauf wurde uebersprungen; kein Lauf benoetigte ein erreichbares
  KI-Modell; keine Produkt-Ratenbegrenzung wurde deaktiviert oder erhoeht.

## Changesets

- `7a9798b93` — deterministische Fixtures, Diagnosevertrag und Managed Auth
- `8c06e5627` — aktuelle Einzel-/Batchauswertung und sichere Legacy-Klassifizierung
- `85c1a140e` — permission-aware Graphprojektion
- `749552359` — Live-Dokument-Auswertung und aktuelle Proofs
- `344f0470d` — fail-closed Managed Review Gate
- `3b67145cc` — produktiver, autorisierter Proposal-Leseweg
- `2c829cfcc` — graphgebundener Compare-Endpunkt und gemeinsamer Text-Diff
- `0c4f9b1d0` — stabiler Auth-/Runtime-isolierter Collaboration-Gesamtlauf

## Abgrenzung

FVRC-1005 oeffnet keine neuen Proposal-Mutationswerkzeuge. Hierarchie, Aktionen,
Diagnosedetails und Batchbedienung im globalen Center folgen in FVRC-1006; die
oeffentliche Aktionsfreigabe und Rollout-Haertung bleiben FVRC-1008.
