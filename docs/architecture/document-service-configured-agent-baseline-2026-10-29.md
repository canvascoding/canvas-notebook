# Dokumentservice: tatsächliche Anlage durch einen Organisations-Agenten

Stand: 29.10.2026. Der unveränderte Produktstand ist
`0e088417588b780ccc3ea24e36e9c3c0eb63869b`; geändert werden ausschließlich die
gemeinsame Test-Fixture, ihre Messauswahl und dieser Nachweis. Der
[maschinenlesbare Bericht](document-service-configured-agent-baseline-2026-10-29.json)
bindet die Testquellen, Originalausgaben und Prüfprotokolle per SHA-256.

Die bisherigen Create-Werte des eingebauten Hauptagenten bilden nicht die
vollständige Zugriffskette eines konfigurierten Agenten ab. Dessen Zugriff muss
zusätzlich aus aktueller Mitgliedschaft, Workspace-Rechten und Agentenfreigaben
bestimmt werden. Die Fixture kann nun einen normalen Organisations-Agenten über
die tatsächliche Profil-Factory erstellen. Der verwendende Benutzer darf dessen
Profil verwenden, aber weder bearbeiten noch verwalten. Die echte gespeicherte
Mitgliedschaft und der unveränderte Zugriffsresolver prüfen diese Einschränkung.
Die vorhandene Hauptagent-Fixture bleibt die Voreinstellung.

Jeder Lauf verwendet einen frischen Prozess, ein eigenes PostgreSQL-Schema und
10 beziehungsweise 200 über normale authentifizierte Uploads angelegte Quellen.
Der Agent verwendet das registrierte `write`-Werkzeug, MCP den echten Web-Request-
Transport. Review Center und Undo bleiben ausgeschaltet. Live-Modellaufrufe,
produktive OAuth-Ausstellung, Browser/Next-Middleware und ein kalter PostgreSQL-
Puffercache gehören nicht zu dieser Messgrenze.

Die Zellen nennen SQL-Treiberaufrufe / Pool-Ausleihen. Transaktionssteuerung ist
enthalten. Mehrteilige Befehlsstrings werden nicht weiter zerlegt.

| Einstieg | Quellen | Erster Einstieg und Anlage | Warme Anlage 1 / 2 | Original-Wiederholung |
| --- | ---: | ---: | ---: | ---: |
| Hauptagent | 10 | 1163 / 68 | 1058 / 34; 1058 / 34 | 168 / 7 |
| MCP | 10 | 723 / 42 | 702 / 29; 702 / 29 | 91 / 12 |
| Organisations-Agent | 10 | 1906 / 68 | 1790 / 34; 1790 / 34 | 264 / 7 |
| Organisations-Agent | 200 | 1906 / 68 | 1790 / 34; 1790 / 34 | 264 / 7 |

Alle 16 Fenster bestehen. Die Dokumentmenge ändert beim Organisations-Agenten
weder Abfragezahl noch Ausleihen. Die zusätzliche Zuordnung der echten SQL-
Aufrufstellen stimmt in allen vier profilierten Fenstern exakt mit den Laufzeit-
Zählern überein und hat keine fehlgeschlagenen Stack-Zuordnungen. Bei der warmen
Anlage liest `getAgentAccessForNormalizedId` 366-mal aus der Datenbank. Die darin
122-mal wiederholte vollständige Zugriffskette erklärt die zusätzlichen 732
Anweisungen gegenüber dem Hauptagenten. Diese Zahlen belegen keine weitere
Produktoptimierung und keinen kontrollierten Latenzgewinn.

Drei frische Anlagen und eine gesonderte ursprüngliche Wiederholung prüfen
native Speicherung, abgeschlossene Projektion, vollständigen Originalinhalt,
Dokument-/Lineage-/Operationsidentität und gespeicherte Fingerprints. Alle
vorherigen Registry-, Lineage-, Native- und Metadatenzeilen einschließlich `xmin`
sowie die physischen Bytes bleiben gleich. Alle Messfenster enden ohne offene
Abfragen/Verbindungen oder fehlgeschlagene SQL-Anweisungen; die eigenen Backends,
Schemas und Datenverzeichnisse werden vollständig freigegeben.

Die abschließende Typprüfung der kanonischen Release-Quellen samt betroffenen
Testeintritten besteht mit 3623 Wurzeln, 8865 Quellen und null Diagnosen. Lint und
die unveränderten registrierten Read-, Edit- und Search-Suiten bestehen ebenfalls.
Eine korrigierte Typangabe im Messskript erzeugt mit TypeScript und esbuild
jeweils bytegleiches JavaScript; die Laufzeitauswahl und ihre Enum-Prüfung bleiben
erhalten. Deshalb gelten die abgeschlossenen Laufzeitmessungen auch nach dieser
reinen Typkorrektur.

Die nächste Produktänderung muss tatsächliche aktuelle Rechte innerhalb derselben
Phase gemeinsam lesen und die spätere erneute Prüfung nach relevanter I/O
erhalten. Die Create-Zielgröße von 200–500 Anweisungen, die übrigen Pakete des
[Serviceplans](../document-write-database-performance-plan.md), finales
`test:all`, PR/Reviews/CI, Backup/Restore, verlustfreie Original-Recovery und
Release bleiben offen. Dieses Test-Update ändert keine Produktionsdaten.
