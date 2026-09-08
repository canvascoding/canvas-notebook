# Routen-Matrix: Dateifreigaben und Markdown-Gäste

Stand: Implementierungsschritte 1–5 auf `codex/file-sharing-and-markdown-guests`.
Die automatisierten Prüfungen arbeiten mit isolierten SQLite-/PGlite-Datenbanken
und direkten Route-Aufrufen bzw. einem Loopback-WebSocket-Testserver. Sie sind
keine Behauptung, dass die UI-Abnahme im tatsächlichen App-Stack bereits erfolgt ist.

| Route | Verhalten und Grenze | Automatisierter Nachweis |
| --- | --- | --- |
| `GET /api/security/public-shares` | Aktuelle Freigaben im berechtigten Workspace; Filter und begrenztes Limit | Workspace-/Lifecycle-Tests |
| `POST /api/security/public-shares` | Erstellen, wiederholtes Erstellen, Teilfehler; neue Links standardmäßig 30 Tage | Workspace-/Lifecycle-Tests, parallele DB-Operationen |
| `PATCH /api/security/public-shares/:id` | Ablauf/HTML-Modus mit `policyRevision`; veraltet 409, fremde Verwaltung abgelehnt | Tatsächliche Web-/Mobile-Handler im Workspace-Test |
| `DELETE /api/security/public-shares/:id` | Berechtigter Widerruf; bereits geöffnete öffentliche Ausgaben werden erneut geprüft | Workspace-/Lifecycle-Tests |
| `/api/mobile/v1/files/shares[/:id]` | GET/POST bzw. PATCH/DELETE verwenden dieselben Handler und Regeln | Aliasvergleich und gemeinsame Handler-Tests; native App-UI offen |
| `GET /p/:code`, `/public/view/:token/:filename` | Anonyme Lesevorschau; ungültige/abgelaufene Links gesperrt, Einstieg an echten Dateinamen gebunden | Resolver-/Routingtests; gerenderte Browseransicht offen |
| `GET/HEAD /public/files/:token/:filename` | Download, Unicode-Dateinamen, korrekte Ranges, HEAD ohne Zugriffszähler | Response-/Lifecycle-/Snapshot-Tests |
| `GET/HEAD /public/markdown-assets/:token/:path` | Nur tatsächlich eingebettete Bilder desselben Workspace; Code/Kommentare/andere Workspace-IDs reichen nicht | Direkte Asset-Handler mit 200/404 und Bytevergleich |
| `GET /public/markdown-export/:token` | Aktueller Markdown-/Yjs-Stand, Inhalts-Cache, erneute Rechteprüfung | Snapshot-/Workspace-Tests |
| `POST /public/markdown-pdf/:token` | Begrenztes Rendererbudget, aktuelle Inhalte und erneute Prüfung vor Ausgabe | Response-/Snapshot-/Exporttests; finaler PDF-Browserlauf offen |
| `GET /public/marp-preview/:token` | Marp-Vorschau mit aktuellen Inhalten und Freigabeprüfung | Workspace-/Snapshot-Tests |
| `GET/POST /api/security/file-guests` | Dateibezogene Einladungen; Team/PostgreSQL und Freigaberechte erforderlich | Gastservice-/Route-Tests |
| `PATCH/DELETE /api/security/file-guests/:id` | Lesen/Bearbeiten, Ablauf, Widerruf mit Versionsvergleich; Ersteller/Verwaltung | Gasttests einschließlich paralleler Policy-Änderungen |
| `GET/POST /api/security/file-guests/versions` | Nur intern mit Schreib-/Freigaberecht; Vorschau, Sicherung und konfliktgeprüfte Wiederherstellung | Gasttests einschließlich reiner Löschungen zwischen Lesen und Wiederherstellen |
| `GET /guest/files/:id` | Öffentliche Anmeldeseite; ID allein gibt keinen Dateiinhalt frei | Proxy-/Route-Tests; Darstellung und Tastatur offen |
| `POST /api/guest/files/:id/challenge` | Code nur an eingeladene Adresse; Cooldown, Versandbudget und Origin | Parallel-/Negativtests mit simuliertem E-Mail-Transport |
| `POST /api/guest/files/:id/verify` | Zeitlich begrenzter, einmaliger Code; fünf Versuche; separates HttpOnly-Gastcookie | Parallele Verifizierung, falsche Codes, Ablauf und Sitzungstests |
| `GET /api/guest/files/:id` | Nur bestätigte Gastsitzung; diese Datei, freigegebene Assets und gebundenes Kollaborationsticket | Direkte 200/401-Route-Tests |
| `POST /api/guest/files/:id/session`, `/checkpoint`, `/logout` | Gebundene Ticket-Erneuerung, berechtigter Speicherpunkt bzw. Gastsitzung beenden | Gastservice-/Kollaborationstests; vollständige UI-Bedienung offen |
| `GET /api/guest/files/:id/assets/:path` | Eingeladene Bilder mit Identitätsprüfung; keine Erweiterung durch nachträgliche Gastpfade | Asset-/Negativtests |
| `WS /ws/collaboration` | Aktuelle Sitzung, Rechte, Datei und Policy vor Nachrichten und im Leerlauf prüfen | Echte Hocuspocus-Verbindungen: zwei Schreibende, Leser, Offline/Reconnect, Widerruf, ungültige Updates |
| Allgemeine Datei-, Mitglieder- und Agent-APIs | Gastcookie stellt weder App-Sitzung noch Workspace-Mitgliedschaft her | Allgemeine Dateiliste, Mitgliedersitzung und Versionszugriff mit Gastcookie: 401 |

## Verbleibende UI-Abnahme

1. Bestehenden verwalteten Notebook-Testcontainer mit diesem Branch neu bauen und
   erstellen; keine zweite Testumgebung. Bootstrap-Login aus privater lokaler Env.
2. Teilen über Dateimenü, Editor und Mehrfachauswahl; 360-Pixel-Viewport,
   Tastatur-Tabs, Fokus, überlange Pfade/E-Mails, Laden/Fehler/Wiederholen.
3. Vorhandenen Link ändern und Ablauf entfernen; gleiche Datei in zwei Workspaces,
   Workspace-Wechsel während Laden/Speichern, Konflikt zwischen zwei Dialogen.
4. Gastcode über isolierten Test-E-Mail-Empfänger, Lesen/Bearbeiten, Live-Präsenz,
   simultane Markdown-Bearbeitung, Reconnect und lokaler Kopie-Download.
5. Entzug von Schreiben/Lesen, Ablauf, Logout, Umbenennen/Verschieben und
   Wiederherstellung; geöffnete Gäste dürfen keine neuen Updates durchsetzen.
6. Öffentliche Markdown-/HTML-Vorschau, eingebettete Bilder und PDF-/Marp-Export
   unmittelbar nach einer kollaborativen Änderung; Widerruf während Export.

Keine echten Einladungen an Dritte versenden. Erst nach dieser Abnahme Schritt 5
abschließen, den gesamten Branch gegen `main` prüfen und den fertigen Stand pushen.
