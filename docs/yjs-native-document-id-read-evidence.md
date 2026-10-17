# Interner nativer Dokumentabruf per ID: Quellen und Prüfgrenzen

Stand: 17. Oktober 2026. Dieser Baustein ergänzt den [Gesamtplan](./yjs-document-authority-consolidation-plan.md). Er aktiviert keine öffentliche Dokument-API, keinen MCP-/PI-/Mobile-Zugang und keinen SDK-/Skill-Vertrag.

## Umgesetzter Schnitt

`readNativeDocumentByIdOnConnection` ist ein interner Beobachtungskern auf einer vom Aufrufer gehaltenen PostgreSQL-Verbindung. Der Aufrufer muss einen echten aktuellen Principal, dieselbe Read-Committed-Schreibtransaktion, die abschließende Autoritätsprüfung, bestätigten COMMIT beziehungsweise ROLLBACK und abgewarteten Verbindungsabschluss bereitstellen. Ein übergebenes Workspaceobjekt ist kein Zugangsbeleg. Der Kern schließt die Verbindung nicht und veröffentlicht keine Antwort.

Die ursprüngliche Registry-ID wählt das Dokument. Endung, Dateiprojektion oder eine Ersatzdatei am früheren Pfad bestimmen die Identität nicht. Registry, Lineage, Zustand und gemeinsamer Titel werden gegen den aktuellen Workspace sowie die tatsächliche Verbindung, Transaktion, Datenbank, Schema-OID und den Suchpfad geprüft. Der Shared-Lifecycle-Guard bleibt bis zum Abschluss der Aufrufertransaktion gehalten. Ein konkurrierender exklusiver Guard oder eine offene Admission wird als benannter Busy-Zustand abgewiesen.

Der Leser validiert die ursprünglichen nativen Bytes einschließlich des rohen Rich-Schemas vor einer Normalisierung und verwendet den vorhandenen Live-/Persisted-Handoff. Der vollständige Zustandsbeleg umfasst Löschungen; ein State Vector allein ist keine Inhaltsversion. Aktuell im Speicher beobachteter Inhalt und tatsächlich dauerhaft gespeicherter Zustand bleiben getrennt. Der Kern exportiert kein Markdown, legt nichts an und repariert keine Quelle. Gültiger Rich-Inhalt, dessen Markdownexport scheitert, bleibt nativ lesbar.

Binärgrößen und benötigte Textfelder werden bereits in SQL begrenzt. Unbenötigte interne Fehlerursachen und Checkpointhashes werden nicht geladen. Fehlende oder quarantänisierte Zustände, Scope-/Versionskonflikte und Größenüberschreitungen behalten unterschiedliche Fehlercodes. Legacy-Nullwerte für Kunde/Projekt werden als ursprüngliche Werte verglichen und nicht nachträglich ausgefüllt.

Zusätzliche reine Vertrags-/Versionierungs-/Seitengrundlagen liefern:

- Strikte Read-Requests und benannte Fehler, ohne Getter eines abgewiesenen Eingabeobjekts auszuwerten.
- Inhaltsversion aus Identität, Generation, Repräsentation, Schema und vollständigem Zustandsbeleg; separate Metadatenversion für Pfad, Titel und tatsächliche gemeinsame Metadatenrevision. Ein realer Move kann die Generation und dadurch auch die Inhaltsversion ändern.
- Vollständige UTF-8-Seiten mit exakten Byteoffsets und ungeteilten Codepoints. Native JSON-Fragmente werden erst nach vollständigem Zusammensetzen geparst. Dies ist noch kein Cursor- oder öffentlicher Lesedienst.

## Quellenbindung

Geprüft wurde Root `e0ae43d204988d6b3e94a91c2b12305876560939` mit genau sechs neuen Quelldateien. Kein zuvor vorhandener App-Kern wurde verändert. Der Quellenfingerprint über 6.929 nicht ignorierte Dateien lautet `278586e4c51c81e64518e80794fe963f8ce6c330ad5e9306f1325d101969d5b0`; alle ursprünglichen Prüfungen bestätigen unveränderte Quellen.

| Datei | SHA-256 |
| --- | --- |
| `app/lib/collaboration/native-document-read.ts` | `eda19018776f5a44650dd0c7d411b1ae409dd3835ae51b33c91f61e9d88fe893` |
| `app/lib/documents/contracts.ts` | `4173f75bc22820388cf7bc099007f368669ebdca98298a4331942764fde4fe08` |
| `app/lib/documents/read-version.ts` | `69106184323bc0861bf1043a926042b77d953d26020b4a1fd7664d6cb5a911f8` |
| `app/lib/documents/utf8-page.ts` | `e8a23e0b5ebed97a27633937202ec2330f57cbc8f02942453941ff99a1e3d0bb` |
| `scripts/document-read-contracts-test.ts` | `fc80cb8e9fde2f75c21b344312effd0f58095d22eaa6725033ce4b6943e6e779` |
| `scripts/native-document-read-postgres-test.ts` | `ce204e79acfd296a9fe445125a1eac1a97534d94bd7ca1217f29759d2614a1b2` |

Die unabhängige Quellenprüfung fand zunächst zwei konkrete P2-Lücken: Schemaattribute konnten vor der Prüfung normalisiert werden, und ein breites SELECT hätte unbenötigte große Textfelder laden können. Beide wurden vor den Ausführungsprüfungen geschlossen. Die letzte Quellenprüfung bestätigt beide Korrekturen. GitNexus kennt die neuen Symbole noch nicht und meldet UNKNOWN, keinen sicheren Nullradius. Die tatsächliche Importprüfung findet bisher nur den neuen PG-Test als Verbraucher. Der bestehende gemeinsam genutzte State-Mapper wurde trotz seines HIGH-Radius nicht verändert.

## Tatsächliche Prüfung und ursprüngliche Abbrüche

Die erste vollständige cachefreie TypeScript-Prüfung endet tatsächlich mit Exit 2: Der neue `const`-Fehlerabbruch wurde nicht als verlässlicher terminaler Narrowing-Schritt behandelt. Lint und Laufzeittests starteten in dieser Queue nicht. Original: `/private/tmp/canvas-native-id-read-quality-t9z6i4_c`, TypeScriptlog SHA `8fd437edd03ecdeb84bf191b138a46c16203876e1300dba651a0fcd8037dac8f`.

Die enge Korrektur ersetzt ausschließlich diesen `const`-Abbruch durch eine Functiondeclaration mit demselben unbedingten Throw und `never`-Vertrag. Die unabhängige inverse Quellenprüfung ergibt exakt den zuvor geprüften Quellhash. Die nächste tatsächliche Queue unter `/private/tmp/canvas-native-id-read-quality-ywm4l19m` liefert:

| Prüfung | Tatsächliches Ergebnis |
| --- | --- |
| Vollständiges TypeScript, 8 GiB, `--noEmit --incremental false` | Exit 0, leeres Fehlerlog |
| Scoped-ESLint aller sechs Dateien, `--max-warnings 0` | Exit 0, leeres Fehlerlog |
| Neun Vertragstests | Child-Exit 0, neun gestartete/neun bestandene Tests, null fehlgeschlagene/abgebrochene/übersprungene/Todo-Fälle |

Der private Queuewrapper erwartete beim Vertragstest TAP-Zeilen, während der originale Node-Reporter neun Checkmarks und exakte erfolgreiche Zähler ausgibt. Deshalb endet der Wrapper mit Exit 1 und startet PG noch nicht. Das tatsächliche Testlog bleibt unverändert erhalten, SHA `c8a52bed215381dec3538244f443cf0369e494b79ef8a656e886a4ccc14fe424`. Eine getrennte strikte Auswertung bestätigt Child-Exit, alle neun ursprünglichen Passzeilen und sämtliche Zähler. Keine Produkt-/Testquelle oder Assertion wurde dafür geändert; TypeScript, Lint und die neun Tests wurden nicht unnötig wiederholt.

Die anschließende ursprüngliche PG-Queue `/private/tmp/canvas-native-id-read-postgres-txp3zh4b` startet nach passendem Quellenfingerprint und eigener Ressourcenbaseline. Sie endet mit **26 tatsächlich bestandenen Fallgruppen, Child-Exit 0 und Queue-Exit 0**. PG-Log SHA: `0c73014502588fc4c2bceb880277c392060d77d1a00e852955155ed44166a3db`. Die Anzahl wird aus tatsächlich nach erfolgreichem Await geschriebenen Passzeilen und dem abschließenden Gesamtzähler bestimmt. Die erfolgreiche Summary allein hätte nicht genügt, weil das Aufräumen danach folgt.

Die PG18-Familien prüfen echte Cookie-/Bearer-Requestprincipals, native Plain/XML/Blocks einschließlich leerer und nicht als Markdown exportierbarer Dokumente, native Dokumente ohne Dateiprojektion, Metadatenrevisionen, Umbenennung und Ersatz am alten Pfad, archivierte IDs, fehlende/verwaiste Zustände, Legacy-Nullwerte und Scopekonflikte. Weitere Familien prüfen rohe Flags/Binär-/Rich-Schemafehler, echte übergroße Bytea-/Textspalten, ausgeschlossene unbenötigte Cause-/Hashwerte, aktuelle Generation, den kontrollierten Live-Handoff, wiederholte/vertauschte Callbacks, Reentry, nachträgliche Änderungen, tatsächliche Backend-/XID-/Suchpfad-/Schema-OID-Abweichungen, echte Lifecycle-/Admission-Sperren, genau dieselbe Verbindung und die finale tatsächliche Sessionwiderrufprüfung. Gegenfixtures schreiben gezielt echte Testzeilen; sie werden nicht als öffentlicher Mutationsvertrag oder als Principalgrant ausgegeben.

## Unabhängiger Ressourcenabschluss

Nach dem tatsächlichen Queueende prüft ein eigener Prozess erneut PG18.4 und dieselbe verwaltete Datenbank. Ressourcenbaseline SHA `2477324eefa2c3cc71840f49b1f5e8e5c9269be6b3a916cfbd92b78784f6e88e`, Abschlussbericht SHA `3d721ec81b0cacd90fd0ccf557141e36c8740f5263f9d7878ae45e973fd983e8`, tatsächlicher Inspector-Exit 0:

- Keine Testschemas mit dem eindeutigen Schemaformat und keine Sitzungen der beiden tatsächlichen Fixture-Anwendungsnamen verbleiben.
- Der DATA-Namensbestand entspricht der Baseline; ein vorher vorhandener Verzeichnisname bleibt in der Liste erhalten. Inhalt und Inodeidentität wurden nicht verglichen. Es wurde nicht pauschal aufgeräumt.
- Vier verwaltete Container behalten identische IDs, Startzeiten und gesunden Laufzustand. Keine Container wurden gebaut, gestartet oder neu erstellt.

Die Fixture wartet ihre Pool-/Clientabschlüsse ab und bestätigt die Entfernung ihres eigenen Schemas. Der unabhängige Check vergleicht Schema-/Sitzungs-/DATA-Bestände vor und nach dem Lauf; er behauptet keine lückenlose Prozessbeobachtung während des Laufs.

## Weiter offen

Der interne Kern hat noch keine öffentlichen Produktaufrufer. Der kontrolliert installierte Live-Handoff im PG-Test ist kein tatsächlicher Hocuspocus-/HTTP-/Browserpass. Der neue DTO-Typ legt noch keinen regulären API-Vertrag oder nachgewiesenen Projektionsstatus fest.

Als nächstes muss der gemeinsame Dienst die echte transportabhängige Autorität, Original-Namespacebindung, sichere Fortsetzung mit Inhalts-/Metadatenversion sowie bestätigten Abschluss vor Veröffentlichung verbinden. Ein Checkpointzähler allein beweist keine fertige Dateiprojektion. Danach folgen progressive Suche, Create-/Import-/Edit-Anschlüsse, SDK/Standard-Skill, zentraler PDF-Import und die übrige Sandboxabnahme. Die abschließende gemeinsame Build-/E2E-Abnahme und Integration des aktuellen main bleiben erforderlich. Undo für Dateiaktionen und Review Center bleiben aus; es gibt keinen PR, Push, Rollout oder allgemeine Aktivierung durch diesen Baustein.
