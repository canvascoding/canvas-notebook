# Schritt 6a-b-1: Exakte installierte Ressourcen und sichere Store-Projektion

Stand: 2026-10-07, Teilschritt 6a-b-1 lokal abgenommen. Finaler Produktionsbuild und beide tatsächlichen Chromium-Browserfälle sind erfolgreich. Die nachfolgende Umsetzung ist kein vollständiges Store-Update-/UI-Redesign.

## Umfang

`GET /api/plugins/catalog` liefert einen begrenzten, versionierten Katalog der aktuell lesbaren installierten Plugin-/Skill-Instanzen. Er verwendet die vorhandenen Ressourcen-Actions und deren aktuelle Actor-/Workspace-/Grant-/Policy-Prüfung. Er erfindet keine neue Namens-, Speicher- oder Ausführungsautorität.

- Eine Instanz besitzt `resourceRef`, Legacy-Referenz, Art, Name, Beschreibung, aktuelle Version/Revision, tatsächliches Eigentum, effektive getrennte Rechte, Aktivierung und sichere Personenlabels. Grants, Checksummen, Dateipfade, Paketinhalt und Connector-/Providerkonfiguration fehlen. Plugin-Kinder erhalten die genaue sichtbare Parent-Referenz vor Kind-/Such-/Seitenfilterung.
- `all`, persönlich/eigene, persönlich/freigegebene, Team, Organisation und System sind Browsing-Auswahlen. Freigegebene Org-/Team-Pakete bleiben dieselbe Instanz mit echtem Eigentum. Lesbare eigene Schatteninstallationen werden als blockierte Verwaltungsmetadaten sichtbar; bestehende Namespace- und Runtime-Aktivierungsregeln bleiben unverändert.
- Team-Picker und Team-URL verlangen aktuelle Workspace-Leserechte aus dem gemeinsamen Scope-Dienst. Eine direkte Paketfreigabe erteilt keine Team-Directory-Berechtigung. Team ohne Auswahl liefert eine Auswahlaufforderung und keine persönliche Ersatzliste. Unbekannte/nicht lesbare Team-ID liefert 404.
- Query-Parsing verwirft unbekannte/mehrfach gesetzte Felder, falsche Bereichskombinationen, übergroße Suche, nicht positive Seiten und Limits über 50. Actor kommt nur aus der authentifizierten Session; Workspace ist ein erneut autorisierter Kontext. Widersprüchliche Header-/URL-Kontexte werden abgewiesen. Auswahl ist kein Berechtigungsbeleg.
- Die ursprüngliche Paketbeschreibung ergänzt das bestehende sichere Ressourcenformat, ohne einen nicht gesetzten Metadaten-Override vorzutäuschen. Aktueller Source-/Checksum-Zugriff im bereits vorhandenen Katalog bleibt bestehen; es wird kein allgemeiner Null-Datei-I/O-Vertrag behauptet.

Die Skill-Store-HTTP-Antwort und der identische Mobile-Reexport nutzen jetzt eine Actor-Projektion. Interne rohe Org-Namensreservierung bleibt für den Installations-/Aktivierungsschutz erhalten, ist aber kein sichtbarer Installed-State-Beleg. Exakte lesbare Instanzen bleiben als `installed.resources` erhalten; bei Mehrdeutigkeit wird keine willkürliche einzelne Version/Aktivierung gewählt. Private Installrecords, Pfade, Grants und installierte Digests fehlen; öffentliche Store-Angebotsdigests bleiben öffentlich. HTTP(S)-URLs werden von Credentials/Query/Fragment bereinigt, lokale/file-URLs fehlen im öffentlichen DTO.

Die neue Prüfung des aktuellen Actors greift auch bei leerem Katalog, vor dem Store-Lesen und nach dessen Wartezeit. Die echte Datenbank-Fixture reproduzierte zunächst, dass ein gesperrter Actor öffentliche Store-Angebote ohne private Instanzen erhielt; der enge Guard verweigert diesen Fall nun mit 403. Nicht existente Actors werden ebenfalls verweigert.

Herkunft wird in diesem Teilschritt noch nicht durch Namen oder aktuelle Versionen bewiesen. Deshalb stehen Eintrags- und Listenvergleich auf `unknown`; Legacy-Update-/Modify-/Restore-Aktionen werden im Actor-Store-DTO nicht angeboten. Die sichtbare Skill-Bibliothek erklärt den unbekannten Vergleich und behauptet im Updates-Tab nicht, alle Pakete seien aktuell. Bestehende interne Aufrufe ohne Actor behalten vorerst ihren Legacy-Vertrag.

## Vorliegende Prüfungen

| Prüfung | Umfang / Ergebnis |
| --- | --- |
| Pure Query/DTO | PASS: strikte Grenzen, exakte Referenzen, Same-name-Instanzen, Parent-Auflösung, Owner-/Audience-Auswahl, 2048-Zeichen-Referenzen, sichere Labels und widersprüchliche Duplicate-Refs fail closed. |
| Actor-Store-Projektion/HTTP-Transport | PASS: sichere Whitelist/URLs, Mehrdeutigkeit, current activation, unbekannter Vergleich, Actor-/Workspace-Weitergabe, statische Fehler und identischer Mobile-GET. Actual SQL authority wird separat geprüft. |
| Tatsächliche PostgreSQL-Engine/Registry/ACL/API | PASS auf dem finalen Source: tatsächliche PGlite/Registry/Better-Auth-HTTP, Same-name Own/Org/Team/Shared, Child-Parent-Pagination, Browse versus Creation-Scopes, gesperrte/nicht existente Actors, ehemaliger Creator und aktueller Membership-/Grant-Widerruf. Zusätzliche Legacy Modify/Restore-Probes und Providerrequests 0; vorhandene Katalog-Checksummen beobachtet (>0, positive Kontrolle). Log: `/tmp/canvas-plugin-catalog-6ab1-final-tests.log`. |
| Bestehende Ressourcen-Actions/Access/Entrypoints | PASS auf dem additiven Source-Beschreibungsfeld: getrennte Rechte, echte Registry, zielgerichtete Freigaben, Alias-/Namespace-Schutz, Audit, aktueller Widerruf und Agenten-Factory. |
| Bestehende Pakete/Skill-Store/Plugin-UI | Package-Gesamtsuite, Legacy-Store und Plugin-App-Gesamtsuite PASS. Das tatsächliche React/JSDOM-UI-Gate prüft in DE/EN ausdrücklich `unknown` statt falschem „keine Updates“ und den aktuellen Workspace im Request. |
| Finale TypeScript und ESLint | Whole-tree `tsc` vor Build und erneut nach der finalen Fixture PASS; ESLint aller 14 geänderten Source-/Fixture-Dateien sowie finale Browser-Fixture PASS. Logs: `/tmp/canvas-plugin-catalog-6ab1-final-tsc.log`, `/tmp/canvas-plugin-catalog-6ab1-after-fixture-tsc.log`, `/tmp/canvas-plugin-catalog-6ab1-final-lint.log`, `/tmp/canvas-plugin-catalog-6ab1-browser-lint.log`. |
| Produktionsbuild | `npm run build` exit 0, einschließlich TypeScript, 3,4 Minuten Compile; kein Containerbuild. Log: `/tmp/canvas-plugin-catalog-6ab1-final-build.log`. |
| Tatsächlicher Produktionsbrowser | **2/2 PASS**, Chromium, ein Worker, keine Retries, 40,1 Sekunden gegen eigenen finalen Hostbuild auf Port 3001. Tatsächlicher Admin/Member, versteckte Orgquelle ohne Store-Installed-State, strikte Query/Team/Workspace-Grenzen, genaue Shared-/Org-/Parent-Referenzen, Grant-Revoke, Actor-Store und sichtbarer Unknown-Vergleich. Log: `/tmp/canvas-plugin-catalog-6ab1-browser-final.log`. |

## Offener Umfang

6a-b-2 ergänzt einen verifizierten dauerhaften Upstream-Anker pro exakter Installation, konservative Legacy-Übernahme, abgeleitete Forks und lokalen Vergleich zur Store-Baseline. 6a-b-3 ergänzt servergeprüfte vollständige Store-Bytes, atomare eingeschränkte Erstinstallation mit Zielbereich/Initialgrants und explizite versionierte Updates unter unverändertem Head-/Meta-/Grant-CAS. Bestehende Workflow-Pins und Freigaben müssen dabei erhalten bleiben. Der Legacy-Replace-Guard wird dafür nicht umgangen.

Die neue Katalog-API ist Grundlage für die vollständige Browse-/Detail-/Installationsoberfläche in 6a-c. Das vollständige Progressive-Disclosure-Redesign, neue gemeinsame OAuth-/Mobile-Wege und echte Drittanbieter-Abnahme bleiben offen. Gateway-Featureflag bleibt standardmäßig aus; keine Veröffentlichung, kein Containerbuild und kein Deployment.

## Bilder, Aufräumen und Grenzen

Desktop 1280 und Mobile 390 in Light/Dark wurden visuell geprüft; unbekannter Vergleich und zentraler Paketbesitz sind lesbar, kein gemessener horizontaler Überlauf. Bilder: `/var/folders/bx/tjzzmjhn2qdcdyfc_l7hkv900000gn/T/canvas-plugin-catalog-browser-e478a19bfe-59xb8o/`. Diese Bilder zeigen den gezielt korrigierten bisherigen Skill-Store; sie sind keine Abnahme des noch ausstehenden grundlegenden 6a-c-Redesigns oder eines Team-Pickers im UI.

Die Fixture bewahrt bereits vor der eigenen Installation eine private Setup-Recovery-Datei und entfernt ausschließlich receiptierten Source/Namespace/Checksum-/Revisionsstand. Der Legacy-Installer aktualisiert auch scoped Skill-Einstellungen; deren voriger Byte-Stand wurde vorher gesichert und nur nach exaktem unverändertem Installed-Abgleich wiederhergestellt. Bei einer fremden zwischenzeitlichen Änderung bleibt die Recovery erhalten. Final wurde die Recovery nach erfolgreichem Cleanup entfernt. Unabhängiger read-only SQL-/Datei-Readback: eigene Ressourcen, Entwürfe, Versionen, Preferences und Intake jeweils 0; eigenes enabledSkill-Element ebenfalls 0. Der Server wurde erst nach PID-/Kommando-/CWD-Abgleich beendet; der fremde Notebook-Container auf 3100 sowie PostgreSQL/Control Plane bleiben erhalten.

Tatsächliche Team-Daten/Entitlements werden in der isolierten Datenbank-Fixture geprüft. Der Browser verwendet den vorhandenen Community-Stack, verändert keine Team-/User-/Profil-/Secret-/Lizenzkonfiguration und beansprucht deshalb keinen tatsächlich gerenderten neuen Team-Verwaltungsablauf. Der neue Katalog ist eine API-Grundlage für 6a-c. Nur ausdrücklich verifizierte Update-Treffer werden später gezählt; der vorläufige Actor-Store meldet Vergleich unbekannt und keine bestätigten Treffer.

## Änderungsprüfung vor Commit

Der abschließende vollständige GitNexus-Index wurde auf dem eingefrorenen Source erfolgreich erneuert. Die frische Staged-Prüfung erfasst 107 geänderte Symbole in den 19 erwarteten Dateien und keine zugeordneten Ausführungsflüsse (Graph-Risiko low). Fehlende Flow-Zuordnung beweist keine fehlenden Aufrufer: Das zuvor geprüfte additive Ressourcen-Beschreibungsfeld besitzt vier direkte und 13 insgesamt betroffene Symbole in vier Modulen (HIGH); die tatsächlichen Ressourcen-/Paket-/UI-Regressionsprüfungen sind erfolgreich.

Der kumulative Vergleich mit `main` erfasst 3599 Symbole in 359 Dateien und 16 erwartete Flüsse aus Agent-Workflow, Execute/Berechtigungen und Settings-Navigation (CRITICAL). Diese Warnung wurde vor dem Commit mitgeteilt. Sie umfasst die bereits akzeptierten vorherigen Schritte; der tatsächlich gestagte Diff wurde auf den Umfang von 6a-b-1 geprüft. Build, TypeScript, fokussierte und bestehende Tests sowie beide tatsächlichen Browserfälle sind PASS; dies ersetzt keine ausstehende Live-Drittanbieter-/Rollout-Abnahme.
