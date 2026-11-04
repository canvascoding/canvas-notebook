# Quellenbeobachtung und parallele Dateiprojektion

Stand: 02.11.2026. Die Korrektur schützt die eigenständige Quellenbeobachtung
für Dateioperationen. Die vollständige kompilierte API-/SDK-Abnahme und das
Release bleiben erforderlich.

## Reproduzierter Fehler

Der Projektionsschreiber hält während der Dateiveröffentlichung die vorhandene
prozessübergreifende Workspace-Sperre und eine gemeinsame PostgreSQL-Zutrittssperre.
Die eigenständige Quellenbeobachtung hielt bisher nur eine gemeinsame
PostgreSQL-Sperre. Beide gemeinsamen PostgreSQL-Sperren sind miteinander
kompatibel. Eine Projektion konnte daher während der Verzeichnis- und
Inode-Beobachtung erscheinen oder ersetzt werden.

Ein lesender Versuch mit den tatsächlichen nativen Zuständen der eigenen
isolierten QA-Datenbank und einem temporären Dateiverzeichnis reproduziert:

| Ablauf während derselben Beobachtung | Ergebnis |
| --- | --- |
| Unveränderte native Quellen | Vollständiger Nachweis mit fünf nativen Dokumenten |
| Dateiprojektion eines registrierten nativen Dokuments wird angelegt | `physical-scope-changed`, kompletter Nachweis verworfen |
| Vorhandene Projektion wird geändert | `physical-source-changed`, kompletter Nachweis verworfen |
| Neue unregistrierte Datei erscheint | `physical-scope-changed`, kompletter Nachweis verworfen |

Die anschließend versuchte Evidence-V5-Erzeugung meldet für die verworfenen
Beobachtungen `NATIVE_SOURCE_EVIDENCE_INVALID`, weil deren privater
Katalognachweis absichtlich fehlt. Die ursprünglichen Dokument-/Yjs-Zeilen samt
Inhalten und `xmin` bleiben unverändert. Diese kontrollierte Reproduktion
beweist den Race; sie beweist noch nicht, dass jeder zuvor beobachtete
kompilierte Vorschaufehler dieselbe Ursache hat.

## Korrektur

`stageWorkspaceLinkSourceAuthorityObservation` hält jetzt dieselbe vorhandene
Workspace-Sperre wie die Projektionsveröffentlichung. Sie wird vor dem Öffnen
der SQL-Verbindung erworben und erst nach Abschluss der Quellenprüfung,
Transaktionsbeendigung und Verbindungsschließung freigegeben. Die Reihenfolge
bleibt Workspace-Sperre vor PostgreSQL-Sperre. Bereits gehaltene
Workspace-Sperren bleiben über die bestehende Implementierung wiedereintrittsfähig.

Der Collector auf einer vom Aufrufer gehaltenen Verbindung bleibt unverändert.
Die UI-Einstiege für Rename und Delete halten ihre Workspace-Sperre bereits um
die gesamte Vorschau. Die erste Quellenprüfung der OAuth-MCP-Vorschau benötigt
denselben Schutz: Der gemeinsame Programmatic-Service hält die Sperre jetzt
auch um `readWorkspacePathImportPreparationPlan`, vor dessen eigener
SQL-Transaktion. Die erneute aktuelle Rechteprüfung bleibt erhalten. Andere
Besitzer ihrer SQL-Verbindung verantworten weiterhin ihre Sperren und Transaktionen.
Quellen-, Namespace-, Versions- und Berechtigungsprüfungen bleiben erhalten.
Ein externer Schreiber außerhalb des Sperrprotokolls kann eine Beobachtung
weiterhin ungültig machen. Es gibt keinen automatischen Schreib-Replay und
keine Ausfilterung ungültiger Quellen.

## Nachweise und Grenzen

Vier neue dauerhafte Tests verwenden echte unabhängige Prozesse und die
wirkliche Kernel-Sperre. Die SQL-Verbindung dieser portablen Tests ist ein
protokollierender Ersatz für einen leeren Katalog; sie ist kein
PostgreSQL-/Berechtigungsnachweis:

- Eine bereits schreibende Projektion verzögert den Leser vor dessen SQL-Checkout.
- Eine während der Beobachtung gestartete Projektion wartet bis nach den
  Dateiprüfungen und der Verbindungsschließung.
- Ein Aufrufer mit bereits gehaltener Workspace-Sperre bleibt funktionsfähig.
- Ein ungeschützter externer Schreiber führt weiterhin zu einer unvollständigen,
  zurückgerollten Beobachtung.

Die ersten beiden Fälle scheitern am bisherigen Produktcode und bestehen mit
der Korrektur. `npm run test:files:original-source` enthält diese Tests und
besteht alle 40 Fälle ohne Skips. Ein vorhandener negativer Preview-Test prüft
nun den bereits vorhandenen öffentlichen Vertrag `PATH_SOURCE_INCOMPLETE`
mit Status 409, unveränderten Quellproblemen, aktueller Rechteprüfung und ohne
Aufruf des HTML-Planners auf verworfenen Quellen.

Ein zusätzlicher privater Versuch führt beide Sperr-Reihenfolgen gegen echte
PostgreSQL-Verbindungen der eigenen QA-Datenbank aus: jeweils ein Checkout,
15 SQL-Anweisungen und fünf native Dokumente mit gültigem Evidence-V5-Nachweis.
Beide Verbindungen schließen; ursprüngliche Dokument-/Zustandszeilen,
`xmin` und Bytes bleiben erhalten. Nur temporäre Projektionsdateien werden
geschrieben und wieder entfernt. Der Workspace-Kontext ist in diesem Versuch
deklariert; er ist kein Nachweis öffentlicher HTTP-Authentifizierung.

Zusätzlich bestehen die 53 Collector-Fälle mit eingebettetem PostgreSQL sowie
gezieltes ESLint und striktes TypeScript über 3754 Wurzeldateien und 9087
Quelldateien ohne Fehler. Die neue Prozessprüfung läuft auch im nativen
API-/SDK-Workflow und erhält ein eigenes Log-Artefakt.

Die zusätzliche öffentliche MCP-Abnahme läuft als
`npm run test:mcp:path-tools:native` über den tatsächlichen HTTP-Dispatcher,
signierte Tokens und PostgreSQL. Zwei neue Move-/Delete-Fälle starten einen
zweiten Prozess während der Quellenbeobachtung. Er veröffentlicht eine
bytegleiche Projektion unter der echten Workspace-Sperre. Der alte
OAuth-Vorschaupfad lässt den Schreiber während seiner Prüfung eintreten; der
korrigierte Pfad liefert eine erfolgreiche Vorschau und lässt die Projektion
erst nach dem Lesen zu. Beide nativen Zustände, Dokumentzeilen und `xmin`
bleiben erhalten. Der Satz besteht nun 15 Testgruppen einschließlich der
bestehenden Widerrufs-, Recovery- und ungeschützten Dateiveränderungsfälle.
Schema, Daten, Clients, Pool und Bundle sind nachweislich bereinigt. Das ist
eine native HTTP-/SQL-Abnahme mit echten signierten Fixture-Tokens; die reale
Browser-OAuth-Ausstellung bleibt eine eigene Prüfung. Beide Prozesssätze
verwenden denselben Testhelfer. Der MCP-Satz läuft ebenfalls in der CI und
erhält ein separates Log-Artefakt.

Die erneute Prüfung des gebauten Servers, des tatsächlichen Projektionsschreibers
und der vollständigen REST-/SDK-Dateioperationen bleibt offen. Die gemeinsamen
Aufrufer mit selbst gehaltener SQL-Verbindung werden davon getrennt geprüft.
Review Center und Undo werden nicht erweitert.
