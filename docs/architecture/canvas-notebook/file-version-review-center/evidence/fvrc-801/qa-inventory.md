# FVRC-801 QA inventory

Dieses Inventar ist vor der zentral koordinierten Browserabnahme eingefroren. Ergebnisse und Screenshots werden nach dem frischen Build/Recreate in `results.md` ergaenzt.

## Ziel und Testgrenze

- Zielsystem: genau ein verwalteter lokaler Team-Seat-Produktionsstack mit PostgreSQL.
- UI-Scope: responsive Web-App und versionierter Mobile-API-Vertrag.
- Native-Grenze: kein separater nativer Client-Claim; native Navigation bleibt ein eigener Meilenstein mit Real-Device-Gate.
- Testobjekt: autorisierte Markdown-Datei in einem geteilten Workspace mit mindestens einer exakten Agentenoperation.

## Funktionale Matrix

| ID | Zustand / Einstieg | Erwartung | Evidence |
| --- | --- | --- | --- |
| N01 | Ungelesene File-Change-Notification in der Bell | Klick oeffnet im selben Fenster exakt Operation, Lineage und Workspace im globalen Center; eigenes Icon und Statuscopy sind sichtbar. | `01-bell-exact-open-desktop-light.png` |
| N02 | Derselbe Eintrag auf Home | Klick oeffnet dieselbe exakte Auswahl wie N01; Workspace-Name bleibt sichtbar. | `02-home-exact-open-desktop-light.png` |
| N03 | Home bei 390 px | Das Notification-Sheet schliesst vor dem Center-Open; Center und Auswahl bleiben erreichbar. | `03-home-sheet-mobile.png` |
| N04 | Erfolgreicher Open | Zustandsfolge ist `unread -> exact selected visible -> read`; es gibt genau einen PATCH. | `04-successful-open-read.png` |
| N05 | Reload und Routenwechsel | Der inhaltsfreie Deep Link reproduziert Workspace, Lineage und Operation; geparste Quelle bleibt `deep_link` und erzeugt keinen weiteren Read-PATCH. | `05-reload-deep-link.png` |
| N06 | Cross-Workspace A nach B | URL setzt generisches und FVRC-Workspace-Ziel atomar auf B; sichtbarer Center und App-Workspace stimmen ueberein. | `06-cross-workspace.png` |
| N07 | Access denied | Center zeigt fail-closed Fehler; Eintrag bleibt ungelesen und es erfolgt kein falscher Zugriff auf A. | `07-access-denied-unread.png` |
| N08 | Missing/stale Operation | Center zeigt stale/not-found; Summary wird aktualisiert, aber kein Read-State geschrieben. | `08-stale-selection-unread.png` |
| N09 | Failed direct apply | Exakte fehlgeschlagene Operation ist sichtbar mit passender Copy, `actionsAllowed: false` und ohne Accept-/Reject-Steuerung. | `09-direct-apply-failed.png` |
| N10 | Mobile API mit Opt-in | `capability=inbox.file_changes.v1` liefert denselben sicheren Link und typisierten Grund; ohne Opt-in bleibt der Legacy-Vertrag unveraendert. | API-/Contract-Protokoll in `results.md` |
| N11 | Timeline-Gutter | Aktuelle Version und History-Karten besitzen links und rechts jeweils 16 px Abstand; Selected-/Focus-Ringe liegen innen. | `10-timeline-gutter-desktop.png`, `11-timeline-gutter-760.png`, `12-timeline-gutter-mobile.png` |

## Viewports und Erscheinungsbilder

- Desktop Light und Dark: 1600 x 900.
- Schmaler Desktop/Tablet: 760 x 900.
- Mobile: 390 x 844 mit Touch.
- In jedem Viewport: Dialoggrenzen, Timeline-Scrollflaeche, Kartenfluchten, Popover/Sheet-Layering, Fokus und horizontalen Overflow messen.
- Status muss durch Icon, Text und Badge ohne alleinige Farbbedeutung lesbar sein.

## Explorative Race-Checks

1. Bell-Eintrag schnell doppelklicken und pruefen, dass nur die letzte Generation oeffnet und hoechstens einmal quittiert wird.
2. Klick starten, sofort reloaden oder die Route wechseln und pruefen, dass kein URL-Parameter einen Trusted-Intent wiederherstellt.
3. Cross-Workspace-Klick A nach B starten und vor Abschluss eine zweite Notification aus C waehlen; nur C darf URL, Workspace und Center festlegen.
4. Erste Operation laden lassen, eine zweite nicht erreichbare Operation waehlen und pruefen, dass der nicht-transiente Ausgangs-Link statt eines stale A/B-Links wiederhergestellt wird.
5. Operation zwischen Inbox-Laden und Center-Resolve aufloesen; der Eintrag darf nicht als gelesen gelten und soll nach Summary-Refresh verschwinden.
6. Nach erfolgreichem Open in der Timeline navigieren und zur Ausgangsoperation zurueckkehren; es darf kein zweiter Read-PATCH entstehen.
