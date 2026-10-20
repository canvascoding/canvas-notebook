# Export- und Migrationskorrekturen

Ausgangspunkt: [Abnahme vom 19.10.2026](../export-migration-2026-10-19/RESULTS.md), Commit `3f8ea8667` mit fünf fehlgeschlagenen E2E-Fällen und einem zusätzlichen Archivfehler.

Die Arbeitsschritte werden nacheinander implementiert, geprüft und committed.

- [x] Exporte: Organisationspfad, leere Verzeichnisse und aktuelle native Text-Checkpoints für Einzel- und Gesamtexport; Benutzerordner namens `cache` bewahren.
- [x] Fehlerbehandlung: sichtbare Downloadfehler und vollständig behandelte Output-Stream-Ablehnungen.
- [x] Dateimigration: sichere Zuordnung, tatsächliche Anwendung vor Serverstart, Rücknahme bei Fehlern und zugesagte Nacharbeiten.
- [x] PostgreSQL: echter Datenbanktransfer unter Erhalt der Zielinstanz und Lizenz.
- [x] Gesamtabnahme: tatsächlicher Export auf isoliertem Ziel, Neustart und Prüfung über API und Browser.

## Validierung des Exports

- Produktionsbuild bestanden.
- Gezieltes TypeScript und ESLint bestanden.
- `migration-export-fidelity-test.ts`: Organisationsdateien, leere Ordner, Ordner namens `cache` und ausdrückliche persönliche Auswahl bestanden.
- `portable-text-checkpoints-test.ts`: Bereichsgrenzen, Wiederholung bei ersetzt gespeicherten Zuständen, Pagination, Verbindungsfreigabe und Blockierung bei Checkpoint-Fehlern bestanden.
- Bestehende Upload- und Secrets-Recovery-Tests bestanden.
- Vier gezielte Browserfälle bestanden: Einzel-ZIPs aller vier Workspace-Typen, frisch im Editor gespeichertes Markdown, Standard-/Full-Admin-Gesamtexporte und leere Verzeichnisse im Migrationsarchiv.
- Zusätzliche Browserprüfung der unveränderten Eigentümer-, Mitglieds-, Admin- und anonymen Berechtigungsgrenzen bestanden.

Die übernommene Quelldatenkopie enthielt zwei bereits quarantänierte alte Dokumente sowie weitere verwaiste native Metadaten außerhalb der neuen Testfälle. Der neue Export blockierte diese Quellen korrekt. Die beschädigten Dateien wurden privat gesichert und ihre Dokumente über die bestehende Lifecycle-Archivierung aus der aktiven Testkopie genommen. Anschließend wurden 115 weitere geerbte native Dokumenteinträge außerhalb `export-99b4/` über dieselbe Archivierung aus der aktiven Testmenge genommen. Die expliziten nativen Testdokumente bleiben aktiv. Die positive Abnahme verwendet damit gültige Testquellen; ein Export mit quarantänierter Quelle bleibt ein separat nachgewiesener Negativfall.

Private Testdaten, ZIPs und Traces liegen weiterhin unter `~/.local/state/canvas-local-team-seat/export-migration-99b4`. Der Stand der ursprünglichen Nachweise wurde vor den Folgetests privat gesichert.

## Validierung der Fehlerbehandlung

- Produktionsbuild, gezieltes TypeScript und ESLint bestanden.
- Der echte ZIP-Schreiber weist geänderte Quelldateien ab und behandelt dabei auch die Output-Promise vollständig; keine zusätzliche `unhandledRejection`.
- Vorbereitete Downloads sind an Benutzer, Sitzung und Workspace gebunden, einmalig nutzbar und nach fünf Minuten abgelaufen. Der Browser puffert das Archiv nicht im RAM.
- Vier Browserfälle bestanden: erfolgreiche Workspace-ZIPs, bestehende Zugriffsgrenzen, Nichtübertragbarkeit/Wiederverwendung vorbereiteter ZIPs und sichtbare Fehlermeldung bei abgewiesenem Download.
- Der Test-Login respektiert HTTP 429 mit einem begrenzten erneuten Versuch nach `Retry-After`; das Anmeldelimit wird nicht verändert.

## Dateimigration

- Der Upload wird anhand sicherer ZIP-Einträge, CRC, Größen, vollständigem Manifest und optionalen Datei-SHA256 geprüft. Die Freigabe bindet den unveränderten Upload an Ziel-Datenbank, DATA, Instanz und konfigurierte Secrets-Pfade.
- Das Mapping verwendet vollständige registrierte Workspace-Wurzeln. Persönliche Daten brauchen ein passendes Zielkonto; Vorschläge werden ausdrücklich bestätigt. Deaktivierte und gesperrte Ziel-Workspaces werden nicht automatisch freigegeben.
- Der tatsächliche Import läuft als eigener Prozess vor Auth, Scheduler und HTTP-Start. Ein dauerhaftes Journal, private Sicherungskopien und wiederholbare Rücknahme schützen unterbrochene Dateiaustausche. Bestehende native Dokumentzustände werden über den vorhandenen Lifecycle archiviert und bei Rücknahme wiederhergestellt.
- Dateiimporte schreiben die ausgewählten Dateien an die bestätigten Ziele. Gleichnamige Zieldateien werden ersetzt; andere vorhandene Dateien bleiben bestehen.
- Alte Sitzungen werden ungültig, aktive Automationen pausiert und OAuth-Zugänge über ihre zentralen Speicheradapter zurückgesetzt. API-Schlüssel bleiben erhalten. Zielinstanz und Lizenz werden nicht importiert.
- Unit-Prüfungen für gefährliche Pfade, Links, Checksummen, Owner-Zuordnung, abgebrochenen Austausch, wiederholte Rücknahme und OAuth/API-Key-Trennung bestanden.
- Ein zusätzlich erzwungener Fehler mit echten PostgreSQL-/Yjs-Dokumenten stellte ursprüngliche Datei, Dokumentidentität, aktiven Zustand und State-Version wieder her; Wiederholung derselben Rücknahme bestanden.

Die geerbte Testquelle enthält 660 registrierte Workspaces, davon 618 deaktiviert und 23 gesperrt. Das unveränderte erste Archiv wird korrekt blockiert. 632 vorhandene Dateiwurzeln dieser alten deaktivierten/gesperrten QA-Workspaces wurden außerhalb der aktiven Quell-Datenkopie privat gesichert; ihre Datenbankstatus bleiben unverändert. Die positive Dateiabnahme verwendet 19 vorhandene aktive Workspace-Wurzeln und 224 Dateien. Das ursprüngliche Archiv bleibt als Negativprüfung erhalten. Dieses Vorgehen ist eine Bereinigung der isolierten Testquelle, keine automatische Wiederherstellung gesperrter Produktdaten.

Die sechs Browserfälle auf der bereinigten Quelle bestanden (Gesamtexporte, Komponenten/Secrets, mehrteiliger Upload, exakte Wurzeln, gesperrte Altbestände und ungültige Archive/Zuordnungen). Zwei Ziel-Browserfälle bestanden nach dem letzten Produktionsbuild: tatsächliche Wiederherstellung nach Neustart samt zugesagten Nacharbeiten sowie vollständiger Export von 224 Dateien in andere bestätigte Workspace-Wurzeln mit anschließendem Öffnen eines nativen Markdown-Dokuments. Desktop- und 390-px-Ansichten wurden geprüft; kein horizontaler Überlauf. Gezieltes TypeScript und ESLint bestanden.


## PostgreSQL-Transfer

- Ein Full Admin Export mit ausdrücklich eingeschlossenen persönlichen Daten erzeugt jetzt einen echten, komprimierten logischen PostgreSQL-Snapshot. Die Datenbank ist standardmäßig nicht ausgewählt.
- Der Snapshot enthält ausschließlich Daten für bekannte, geprüfte Tabellen und Zieltypen. Unbekannte Tabellen, ein abweichendes Schema und eine andere Organisation blockieren den Import. Bestehende Konten mit derselben E-Mail müssen dieselbe ID haben; eine bereichsübergreifende Neuzuordnung solcher Konten ist auf die Dateimigration beschränkt. Damit bleiben auch gespeicherte persönliche Namensräume konsistent.
- Lizenz-, Zielorganisations- und Team-Seat-Tabellen werden nicht importiert oder beschrieben. Ihre tatsächlichen Zielinhalte werden vor und nach dem Datenbankaustausch verglichen. Zielkonten, die nur zum Ziel gehören, bleiben erhalten.
- Aktive Sitzungen, OAuth-Zugänge, Freigabe-/Gastzugänge, Verbindungsregistrierungen und laufzeitgebundene Warteschlangen werden nicht als aktive Berechtigungen übernommen. Passwort-Hashes gehören zum ausdrücklich bestätigten persönlichen Datenexport. Benutzerinhalte und Chatverläufe bleiben unverändert; sie können früher hineinkopierte Links oder Zugangsdaten enthalten. Der Export bleibt ein privates, unverschlüsseltes Archiv.
- Daten werden mit gebundenen Parametern gegen die bekannten PostgreSQL-Zieltypen eingespielt. Vom Archiv kommt kein ausführbares SQL. Fremdschlüssel und Zielvorgaben müssen vor der Dateiveröffentlichung bestehen; automatisch erzeugte numerische IDs werden ohne Rücksetzen der Sequenzen fortgeführt.
- Der Datenbankaustausch liegt in einer Transaktion. Ein zusammen mit dem Commit gespeicherter Beleg unterscheidet einen bestätigten Austausch von einem abgebrochenen Versuch beim nächsten Start. Die Workspace-Dateiwurzeln werden dazu mit privaten Sicherungen ausgetauscht. Konfigurierte Ziel-Schlüssel bleiben erhalten.
- Der abschließende direkte Test spielte 133 Tabellen mit 126.229 Datensätzen in einer echten PostgreSQL-Transaktion ein und nahm diese wieder zurück. Die Zeilenanzahl jeder übernommenen Tabelle wurde geprüft; Ziel-Lizenzdaten und sämtliche Trigger-Modi blieben unverändert. Verzeichnisaustausch und wiederholte Dateirücknahme mit einem Schlüssel innerhalb der Workspace-Wurzel bestanden ebenfalls.
- Die Zielkopie hat jetzt eine eigene Instanz-ID und eine eigene über die regulären lokalen Community-/Claim-/Development-Team-Flows aktivierte, nicht abrechenbare Entwicklungslizenz. Veraltete Verbindungsdateien der ursprünglichen Kopie wurden privat gesichert; keine Lizenz wurde durch direkte SQL-Änderungen hergestellt.
- Produktionsbuild, gezieltes TypeScript, ESLint, Upload-, Archiv- und Secrets-Prüfungen bestanden.
- Die Datenbank-Browserfälle bestanden innerhalb der vollständigen Gesamtabnahme: echter Datenbankexport mit nachweislich entfernten OAuth-Fixture-Tokens, Blockierung eines reinen Metadatenarchivs und Export/Upload/Bestätigung/Neustart auf der separat lizenzierten Zielinstanz. Beim Zieltransfer wurden 126.261 Datensätze aus 133 Tabellen, alle 228 Workspace-Dateien, acht binäre native Dokumentzustände, beide erhaltenen/pausierten Automationen und Unicode-Sonderfälle geprüft. Quellprojekt, Zielinstanz, Ziel-Lizenz, Ziel-API-Key und Sitzungsabmeldung wurden tatsächlich geprüft.

Der längere Datenbankexport deckte außerdem ein bestehendes Rennen beim Lesen des Fortschritts auf: eine gerade überschriebene Statusdatei konnte kurz als fehlender Auftrag erscheinen. Exportstatus wird jetzt atomar gespeichert. Die Wiederholungen des echten Browserexports bestanden.

## Gesamtabnahme

20 von 20 End-to-End-Fällen bestanden ohne Wiederholung oder übersprungene Fälle. Der letzte Gesamtlauf deckte zusätzlich den Verlust von Automationen und Änderungshistorie durch eine zu breite Abhängigkeitsregel auf. Optionale Verbindungsverweise werden jetzt geleert; dauerhafte Operations-/Vorschlags-/Bestätigungshistorien bleiben erhalten. Generierte PostgreSQL-Spalten sowie Regeln für historische Zustandsübergänge werden beim Import korrekt behandelt; Fremdschlüssel bleiben geprüft und alle Trigger-Modi werden wiederhergestellt. Build, gezieltes TypeScript, ESLint und relevante Einzelprüfungen bestanden. Der vollständige Nachweis mit Grenzen und Aufräumstatus steht in [RESULTS.md](RESULTS.md).
