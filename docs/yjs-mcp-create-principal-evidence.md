# MCP-Schreibprincipal: fester Schemawechsel für native Anlage

Stand: 18. Oktober 2026. Dieser Nachweis betrifft ausschließlich den bereits eingeführten festen MCP-Schreibprincipal und seine PostgreSQL-Schemaprüfung. Er ist keine vollständige Create-/Import-, HTTP-/OAuth-, Browser- oder SDK-Abnahme.

## Problem und Korrektur

Die vorhandenen nativen Import-/Birth-Trigger setzen lokal den Suchpfad auf das tatsächliche Schema sowie `pg_catalog, pg_temp`. Der Schreibprincipal verlangte bisher auch danach den unveränderten ursprünglichen Suchpfad seiner Verbindungsfabrik. Eine echte PostgreSQL-Gegenprobe beendet sich deshalb mit Exit 1.

Nur die feste Create-Policy wechselt nun vor dem Consumer auf diesen vorhandenen Triggerpfad. Zuerst müssen ursprünglicher Datenbank-/Schema-OID, Suchpfad, Backend, Backendstart und Transaktion tatsächlich stimmen. Anschließend wird ausschließlich der aus diesem bestätigten Schema gebildete lokale Pfad gesetzt und auf derselben Verbindung erneut geprüft. Ein vorher falscher Suchpfad kann dadurch nicht repariert oder verdeckt werden. Historische Herkunft behält den tatsächlichen ursprünglichen Fabrikpfad; Read/Search behalten ihre bisherige exakte Pfadprüfung. Zeitgrenzen und Berechtigungen werden nicht erweitert.

GitNexus meldete für die bestehende Funktion `identity` drei direkte Aufrufer, acht betroffene Symbole und Risiko LOW. Die neue gemeinsame Principal-Funktion und neue Testfunktion waren im vorherigen Index nicht enthalten; dafür wird kein Nullrisiko behauptet. Die tatsächlichen festen Read-/Create-Aufrufer wurden zusätzlich im Quelltext geprüft.

## Tatsächliche Prüfungen

Die beiden geprüften Quelldateien sind:

| Datei | SHA-256 |
| --- | --- |
| `app/lib/mcp/server/document-read-principal.ts` | `3e1e725ecb1d3666d9b2ab44f89045292a5697f684c66cd46a37747c618ad6aa` |
| `scripts/direct-mcp-document-create-principal-postgres-test.ts` | `5e21f78f1245c235104007d39f7c09b4f5addd51dfac6988e998c7aacb4aec52` |

Originalbelege liegen im privaten Integrationsverzeichnis `/private/tmp/canvas-native-mcp-create-3da14de86-pez2gd_z/`. Sie enthalten keine veröffentlichbaren Credentials und sind keine zusätzlich benötigte Produktlaufzeit.

| Prüfung | Tatsächliches Ergebnis | Originalbeleg SHA-256 |
| --- | --- | --- |
| PostgreSQL-Gegenprobe vor Korrektur, Session 44466 | Exit 1 am unveränderten Trigger-Suchpfad; negativer Beleg erhalten | `76ea44a23a2a22056d20b4562fabb736d66cc5a3d09e0f27ea5b5e15fcd9d391` |
| Create-Principal, Session 76555 | Exit 0, acht von acht echten JWT-/SQL-/Lebensdauergruppen | `37a09ac72ddbc8fa120599f8dfddaf76ed58795f91f251bb43a3d017c0adb792` |
| Bisheriger Read-Principal nach Korrektur, Session 16912 | Exit 0, 20 Gruppen; eigene Clients, Schema, DATA und Bundle geschlossen | `92eac3583a059d8396251db59c5a30668f98f2bcf0a88cc9d90b5153da7a2fae` |
| Scoped-Lint, Session 12536 | Exit 0, keine Ausgabe | `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` |

Die achte neue Gruppe prüft beide festen Schreibtools, den echten lokalen Suchpfad, unveränderte ursprüngliche Herkunft, Ablehnung einer vorher manipulierten Verbindung und unveränderten Read-Pfad. Die PostgreSQL-Proben verwenden echte isolierte Schemas im vorhandenen PG18-Dienst; Authentifizierung oder SQL-Ergebnisse werden nicht ersetzt.

## Verbleibende Grenzen

Die frühere vollständige Typprüfung des vorangehenden Principal-Kernels endete mit Exit 2 bei genau 69 bytegleichen geerbten Main-Diagnosen. Sie wird nicht als erneute Typprüfung dieser Korrektur oder des nachfolgenden Engine-Entwurfs ausgegeben. Der neue Gesamt-Typecheck ist noch nicht abgeschlossen: Ein Lauf erreicht die standardmäßige Node-Heapgrenze; der zweite wird ausschließlich als eigener Compilerprozess wegen tatsächlich beobachteter starker Hostauslastung beendet. Beide Originalausgänge bleiben erhalten, ohne Compilererfolg zu behaupten.

Der anschließend separat geprüfte native Engine-Entwurf besteht sieben tatsächliche registrierte MCP-/PG-/FD-/Prozessgruppen. Er ist beim Anlegen dieses Nachweises noch nicht Bestandteil dieses Principal-Commits. Seine bisherigen Web-Importregressionen, echter HTTPS-Import, gemeinsame Ergebnis-/Edit-Verträge sowie kompilierter HTTP-/OAuth-/Browseranschluss bleiben eigene Abnahmen. Der zuvor mit PostgreSQL `25P04` fehlgeschlagene Web-Importfall besteht in einer unveränderten Einzelgegenprobe; seine ursprüngliche Ursache ist damit nicht bewiesen und der ursprüngliche Gesamtlauf bleibt fehlgeschlagen.

Allgemeine native Aktivierung, Dateiaktions-Undo und Review Center bleiben ausgeschaltet. SDK, Standard-Skill, PDF-Anschluss, übrige Sandboxwege und vollständiger Gesamt-E2E bleiben im Auftrag.
