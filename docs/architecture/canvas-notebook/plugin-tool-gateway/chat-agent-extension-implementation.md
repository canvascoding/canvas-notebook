# Gemeinsamer Chat-/Agent-Erweiterungskontext: Umsetzung und Abnahme

Ausgangsstand: Notebook `d92d8eb05`. Auftrag: „setz den plan um und mach ein e2e test wenn du fertig bist“. Verbindlicher Umfang ist der [gespeicherte Plan](chat-extension-reference-plan.md), einschließlich eigener nativer Folgestufe. Dies ist ein Fortschritts-/Nachweisjournal; eine geplante oder syntaktisch geprüfte Funktion ist hier keine vollständige Abnahme.

Nutzeranweisung im Planungsschritt vom 13. Oktober: „Gib mir erstmal feedback mit dem plan dann speicher den in docs ab und dann optimieren wir das noch“. Dieser abgeschlossene Arbeitsschritt aktualisierte ausschließlich den Plan. Er erklärte die vorbereiteten Implementierungsstände nicht für abgeschlossen oder abgenommen.

Nach der gespeicherten Planprüfung wurde das aktive Ziel „setz den plan um und mach ein e2e test wenn du fertig bist“ erneut zur Fortsetzung gegeben. Die Implementierung wird ab diesem Nachtrag fortgeführt; die folgende Abnahmematrix bleibt bis zu tatsächlichen Nachweisen offen.

Aktuelle Rückmeldung am 14. Oktober: Auf Wunsch „Gib mir erstmal feedback mit dem plan dann speicher den in docs ab und dann optimieren wir das noch“ wird jetzt der Plan besprochen und präzisiert. Backend-Checkpoint ist `fbb7e3a6e`; bereits begonnene uncommittete Optionsvertrags-, Composio-Katalog- und Paketleser-Entwürfe bleiben erhalten. Sie sind kein abgeschlossener gemeinsamer Optionsdienst und kein UI-/E2E-Nachweis. Dieser erneute Planungsschritt bearbeitet ausschließlich Dokumentation; die weitere Umsetzung folgt der gemeinsamen Planoptimierung.

## Reihenfolge

| Schritt | Stand | Erforderlicher Nachweis |
| --- | --- | --- |
| 1. Gemeinsamer Referenzvertrag und Autorität | Abgeschlossen als Grundlage: genaue öffentliche Referenzen, private Paket-/Standalone-Formate und geprüfte Verbindungsaufnahme; Runtime-Anschluss folgt in Schritt 2 | Vertragsmatrix, V1-Erhaltung und tatsächliche Actor-/Connection-Aufnahme geprüft; keine fertige UI oder vollständige neue Runtime behauptet |
| 2. Gemeinsamer Kontextcompiler | Abgeschlossen als Runtime-Grundlage: gemeinsame Prompt-/Root-/Toolquelle, genaue Turn-/Paketverbindungen und frische SQL-gebundene Delegation geprüft; Produktionsbuild und fokussierte Type-/Regressionchecks bestehen | Tatsächliche Source-/Scope-/Entzugsfälle und Caller-Reihenfolge geprüft; öffentliche Agent-Schreibwege, Chat-Bedienung und dauerhafte Wiederaufnahme folgen separat |
| 3. Agent-Tool und Oberfläche | In Arbeit: vollständiger öffentlicher Create-/Update-/Inspect-/Choice-Schreibweg als Backend-Grundlage lokal geprüft; gemeinsame Optionsprojektion und neue Oberfläche offen | Exakte Standalone-Verbindungen vorhanden; Prospective-Optionen, Kontextvorschau und tatsächlicher Tool↔UI-Roundtrip folgen |
| 4. Chat-Picker und Transport | Offen | Alle vier Typen, Recents, Suche/Filter, genaue Accountwahl, Chips, Drafts, Queue, Steer, Retry und Handoff |
| 5. Web-/Agent-/Modellabnahme | Offen | Frischer Produktionsbuild; reale Browserbedienung und echter Modelllauf mit selbst gefundener Skill-Anleitung und gezieltem Toolrouting |
| 6. Native Mobile | Offen | Eigener nativer Composer, Transport, Verlauf/Drafts und Agent-Konfiguration; eigene Simulator-/Geräte-/Accessibility-Nachweise |

Jeder Schritt muss abgeschlossen sein, bevor die nächste Integration beginnt. Parallele Bestandsaufnahme und Prüfung innerhalb eines Schritts sind keine vorgezogene Umsetzung späterer Schritte.

## Verbindliche Abnahmematrix

Alle folgenden Nachweise sind zunächst **offen**. Die 15 vorhandenen Pluginseiten-Browserfälle beweisen diese neuen Chat-/Agent-Anforderungen nicht.

| Planfall | Erforderlicher tatsächlicher Nachweis |
| --- | --- |
| 1 | Recents erst nach akzeptiertem Send; idempotent bei Retry; Hover/Abbruch ohne Speicherung |
| 2 | Gemeinsame Vier-Typen-Suche, optionale Filter und spätere Composio-Katalogseite |
| 3 | Gleichnamige Pakete/Skills/Kinder/Verbindungen als getrennte exakte Quellen |
| 4 | Persönlicher versus Team-Account; Use ohne Manage; keine erste Instanz als Ersatz |
| 5 | Installations-/Auth-/no-auth-/Ausfall-/Rechtesituationen mit zutreffenden Aktionen |
| 6 | Gehaltene Antworten nach Actor-/Workspace-/Agent-/Profilwechsel werden verworfen |
| 7 | Chip entfernen; Draftreload, Handoff, Follow-up/Steer, Queueedit und Retry erhalten die eigene Auswahl |
| 8 | Rechteentzug zwischen Auswahl, Send, Queue, Describe und Call stoppt vor Nutzung |
| 9 | Registrierter Gateway/Legacy-Vertrag/Workflow-Konfiguration: nur tatsächliche zulässige Tools empfohlen |
| 10 | Ausgewähltes Plugin: echter Modelllauf liest passenden Skill und verwendet exakt passende Tools; Budget eingehalten |
| 11 | Ungültige gehaltene Quelle/Bindung/Schema verlangt Neuauflösung; neue Head-Version allein invalidiert keinen erlaubten Pin |
| 12 | Tastatur/IME/Screenreader, DE/EN, Desktop/schmaler Web-Dock; native Nachweise getrennt |
| 13 | Tatsächliches `create_agent` mit Paket/Kinder/Standalone-Verbindungen → identischer Stand in Management-UI |
| 14 | UI-Create → identischer Tool-Inspect; atomarer Create und konkurrierender Edit mit Revisionen |
| 15 | Neuer/bestehender Spezialagent-Chat ohne Slash enthält seine feste Auswahl |
| 16 | Allgemeiner Chat ohne Slash/Skillnamen/Toolrezept: echtes Modell findet passenden Skill über Runtime-Discovery und liest ihn |
| 17 | Core/Pflicht, Legacy-Vererbung, feste/leere Auswahl und V1-Pins ohne stille Umdeutung |
| 18 | Organisationsagent: gemeinsame Verbindung versus zulässige persönliche Wahl je ausführendem Nutzer |
| 19 | Fehlendes Lese-/Gateway-Tool, notwendige/optionale Einrichtung, lokaler Skill trotz Providerausfall und große Pakete |
| 20 | Gleicher Selektionsfingerprint für Prompt/Readroots/Toolhinweise; sicherer Refresh und aktive Laufgrenzen |
| 21 | Planungsmodus: sichere Discovery; keine Accountprobe oder Ausführung; Delegation/Scheduler innerhalb aktueller Policy |

Zusätzlich: manuelles Öffnen erhält Nachrichtentext/Caret; Slash-Auswahl entfernt nur ihre erfasste Range; Auswahl allein sendet keinen Auftrag.

## Bestätigte Ausgangslücken

- Agent-Create unterstützt noch keinen vollständigen gehaltenen Workflowstand; Update und Create müssen denselben neuen Vertrag bekommen.
- Workflow V1 ist paketgebunden. Standalone-Verbindungen benötigen eine versionierte Erweiterung bestehender Bindungen; temporäre Account-Selection-Receipts dürfen nicht als langlebige Identität gespeichert werden.
- `ChatRequestContext` wird ausdrücklich normalisiert und gehört bisher nicht zur dauerhaften Nachrichtenprojektion. Runtime-Kontextsnapshots und Queues liegen im RAM; Reload-/Rehydrate-Nachweise benötigen tatsächliche Persistenz samt eindeutiger Zustände.
- Web- und Native-Drafts speichern bisher nur Text. Native-Realtime und Native-Agent-Editor haben eigene Verträge und müssen separat angepasst werden.
- Vorhandene Modellprüfung instruiert den Workflow stark. Für natürliche Skill-Discovery ist zusätzlich eine echte Aufgabe ohne Slash, Skillnamen oder vorgegebenes Toolrezept erforderlich.
- Zu Beginn sind keine nativen Simulatoren/ADB-Geräte aktiv. Simulator-/Build-Auswahl und physische Geräte-/Accessibility-Abnahme sind unterschiedliche Nachweise.

## Erster geprüfter Teil: Referenz- und Bindungsverträge

Die neuen gemeinsamen Schemas unterscheiden Plugin, eigenständigen/enthaltenen Skill, Composio und MCP. Nachrichten- und Agent-Hüllen teilen dieselbe genaue Identität; der Agent-Vertrag erhält vollständige Workflow-V1-Deklarationen und ergänzt feste/auswählbare Standalone-Verbindungen. `legacy_inherit` und eine leere feste Auswahl sind ausdrücklich verschieden. Kurzlebige Account-Receipts kommen ausschließlich bei der Annahme vor, nicht in akzeptierten Nachrichten oder privaten gespeicherten Bindungen.

- `npm run test:extensions:contracts`: bestanden; 92 öffentliche Fälle plus private Bindungs-, Slotreferenz- und Workflowversionsprüfungen.
- ESLint der neuen Vertrags-/Hilfsdateien und ihrer fokussierten Tests: bestanden; `git diff --check` ebenfalls bestanden.
- Typecheck der neuen Module und Tests einschließlich ihrer tatsächlichen importierten App-Abhängigkeiten und bestehenden Ambient-Typen: bestanden. Temporäre Konfiguration `/private/tmp/canvas-extension-foundation-typecheck-20261013.json`, ausgeführt mit `node --max-old-space-size=8192 node_modules/typescript/bin/tsc -p … --pretty false`.
- Ein vollständiger `tsc --noEmit --incremental false` brach zunächst am Standard-Heaplimit ab. Mit 8 GiB berichtete er zahlreiche Fehler in anderen vorhandenen Script-/Testdateien sowie einen neu eingeführten Assert-Overload im Versions-Vertragstest. Der neue Overload wurde korrigiert. Dieser vollständige Repository-Typecheck wird nicht als bestanden ausgegeben; der fokussierte Nachweis schließt fremde Script-/Testdateien aus, nicht die importierten App-Abhängigkeiten.
- Die unabhängige Prüfung fand unterschiedliche öffentliche/private MCP-Definitions-ID-Grammatik. Die tatsächliche Quellvalidierung verlangt kanonische UUIDs; beide neuen Verträge und die gemeinsame Gegenprüfung wurden daran ausgerichtet.

Diese Nachweise prüfen Syntax, interne Konsistenz, gehaltene Identitäten, Grenzen und das Weglassen privater/kurzlebiger Eingabefelder. Sie beweisen noch keine aktuelle Actor-/Providerautorität, kein fertiges Agent-Create, keinen neuen Systemprompt und keine Chat-/Native-Bedienung. Die serverseitige Annahme einzelner Verbindungen wird anschließend mit den vorhandenen echten Berechtigungsdiensten und eigener isolierter Datenbank geprüft. Schritt 1 bleibt bis zu dieser Autoritätsprüfung offen.

## Geprüfte Annahme genauer Standalone-Verbindungen

`prepareStandaloneExtensionSelection` konsumiert die ausdrückliche persönliche oder geteilte Auswahl über die vorhandenen Dienste und stellt einen serverseitigen, actor-/session-/workspace-/projectgebundenen Beleg aus. Der private gespeicherte Zielstand enthält keinen kurzlebigen Composio-Auswahlbeleg. Geänderte Identität, Zugangskonfiguration, Profilstatus oder Bindung wird bei erneuter Prüfung abgewiesen. Ein JSON-/Spread-Klon stellt keinen Serverbeleg her.

Der gezielte Nachweis `scripts/extension-standalone-preparation-native-test.ts` wurde nach den letzten Korrekturen frisch erfolgreich ausgeführt:

- tatsächliches PostgreSQL am verwalteten Loopback-Port `55433`, eigene noncegebundene Datenbank und eigenes DATA; tatsächliche Actor-, Mitgliedschafts-, Config-API- und Connection-Store-Dienste;
- persönlicher MCP über die tatsächliche Config-API; geteilte Nutzung ohne Manage; falscher Eigentümer, widersprüchlicher Projektkontext, Bindingänderung, Grantverengung und Rechteentzug;
- tatsächlicher Composio-SDK mit eigenem HTTP-Metadatenprovider, ausdrücklich zweiter von zwei aktiven Accounts, no-auth, fehlendem/manipuliertem Beleg, anderem Actor, Credentialrotation und archiviertem Profil;
- 7 erlaubte Metadatenabrufe, 1 blockierter SDK-Hintergrundversuch, 0 Business-Aufrufe und 0 externe Netzwerkanfragen;
- nach Ende nachgewiesene Abwesenheit der exakten eigenen Datenbank und DATA sowie geschlossene eigene Providerlistener; keine fremde Instanz verändert;
- fokussierter Typecheck einschließlich der tatsächlichen importierten App-Abhängigkeiten und Ambient-Typen sowie ESLint bestanden.

Ein zunächst akzeptierter widersprüchlicher Shared-Projektkontext wurde durch kanonische SQL-Actorprüfung vor Aufnahme, nach I/O und bei Revalidierung korrigiert und mit demselben tatsächlichen Testfall erneut geprüft. Zusätzlich wird geteilte Revalidierung mit einer angegebenen SQL-Schreibverbindung explizit abgewiesen: der außerhalb dieser Transaktion gelesene Beleg ist keine Commit-Autorität. Spätere Schreibvorgänge müssen Connection-Locks und aktuelle Autorisierung für den tatsächlichen Zielagenten innerhalb der Transaktion verwenden. Persönliche Revalidierung mit gehaltener SQL-Verbindung wurde separat geprüft.

Diese Fixture verwendet eigene synthetische Lizenz-/Authdaten. Der Nachweis ist keine Control-Plane-Lizenzabnahme, keine externe Providerabnahme, kein Modelllauf und keine Browser-/Native-Geräteprüfung. Der Name „native“ bezeichnet hier tatsächliches PostgreSQL statt eines Speicheradapters. Der Einstieg `npm run test:extensions:preparation:native` setzt eine privat übergebene verwaltete `DATABASE_URL` voraus; Zugangsdaten werden nicht protokolliert.

## Geprüfter gemeinsamer Speichervertrag und V1-Adapter

Ein neuer Paketwrapper hält die unveränderte private Workflow-V1-Konfiguration und ergänzt die genaue Plugin-/Kindauswahl. Auch eine leere Plugin-Teilmenge entfernt dabei keine gespeicherten Elternanforderungen. Die gemeinsame Formatprüfung unterscheidet SQL-`NULL`-Vererbung, V1-Pakete und die neue ausdrückliche Gesamtkonfiguration mit V2-Paketwrappern sowie Standalone-Verbindungen. Eine leere V2-Auswahl ist ausdrücklich keine Vererbung. Connection-Slots erhalten die vom Konfigurationsslot abgeleitete Identität; gleiche Paketressourcen und doppelte Slots werden abgewiesen.

- Der Paketwrapper-Test besteht für gehaltene Pins, all/subset, zusätzlich ausgewählte Kinder, Root-Skill, Herkunft, Kindmarker und unveränderte V1-Deklarationen.
- Die ergänzte Dispatcher-Matrix weist 93 beschädigte/mehrdeutige Protokollfälle ab, einschließlich ansonsten feldgültiger, insgesamt zu großer Daten. Ein kleiner Kontrollfall wird akzeptiert.
- `npm run test:extensions:contracts` mit allen sechs Vertragsskripten, fokussierter Typecheck mit den tatsächlichen App-Abhängigkeiten und ESLint bestehen am aktuellen Stand.
- Der neue Runtime-Discovery-Vertrag legt die lokale read-only Operation `search_canvas_extensions` unter dem vorhandenen `canvas_extensions`-Gateway fest. Sie sucht zulässige installierte Plugin-/Skill-Metadaten; externe Verbindungs-/Tooldiscovery bleibt im bestehenden Integrationsgateway. Registrierung, autorisierte Projektion und Promptanleitung werden im nächsten Schritt angeschlossen.

Zum Abschluss dieses ersten Teils waren die neuen Formate noch nicht an produktive Leser oder Mutationspfade angeschlossen. Schritt 2 erweitert Leser, Auswahlprojektion, Prompt, Readroots und Tool-Registrierung gemeinsam, bevor ein öffentlicher Create-/Update-Pfad V2 schreibt. Rechteprüfungen bleiben auch danach frisch; die Codec-Matrix ist kein Ausführungsnachweis.

## Zweiter Teil: Versionsleser, genaue Runtime-Auswahl und Metadaten

Stand 14. Oktober 2026. Die tatsächlichen Leser prüfen nun SQL-Header und private Bindungsformate gemeinsam. V1, ausdrücklich leere V2-Auswahl und SQL-NULL-Vererbung bleiben verschieden. Unbekannte oder widersprüchliche Formate werden abgewiesen. Ein alter Workflow-Update darf eine V2-Konfiguration mit Standalone-Auswahl nicht überschreiben; der vollständige öffentliche V2-Schreibweg folgt in Schritt 3.

Die Paketprojektion hält veröffentlichte Pins, Elternanforderungen und zulässige Kindmasken. Die Standalone-Projektion berücksichtigt genaue persönliche/geteilte Identität, aktuelle Nutzungsrechte, individuelle Auswahl und Toolgrenzen. Die initiale Kontextaufbereitung liest lokale Identitäts- und Berechtigungsmetadaten ohne Provider-Probe; notwendige Provider-Readiness wird weiterhin am tatsächlichen Nutzungspfad geprüft. Ein JSON-Klon kann keine ausgegebene Runtime-Autorität weiterreichen.

Ein kompakter Renderer verwendet tatsächlich registrierte Tools und deren Policy-Grenzen. Er enthält den Selektionsfingerprint, genaue Lesepfade und Provider-Suchwege nur im zulässigen Umfang. Ein gemeinsames UTF-8-Budget von 8 KiB kürzt optionale Details; notwendige Identitäten und Hinweise bleiben erhalten. Die lokale Operation `search_canvas_extensions` wird im bestehenden Erweiterungsgateway registriert und ist im Planungsmodus erlaubt. Sie liefert Metadaten und Skill-Orte, keine ausführbaren Leserezepte oder neuen Freigaben. Suchergebnisse und Kontext verwenden dieselbe Relevanzregel.

Die tatsächliche Root-Skill-Fixture fand eine Lücke: Bei natürlicher Discovery wurde ein manifest-deklarierter Root-Skill erneut mit der gewöhnlichen Ordnernamensregel geparst. Nun wird die Ausnahme ausschließlich aus der bestätigten veröffentlichten Plugin-Root-Herkunft abgeleitet. Auch ohne ausdrücklichen Turn-Pin behalten gefundene veröffentlichte Skills ihre genaue Elternressource, Revision, Checksumme und Kindwurzel. Eingeschränkte Legacy-Agenten bekommen kein vollständiges Plugin als passend angeboten, dessen Kinder außerhalb ihrer Auswahl liegen.

Bestätigte Nachweise dieses Teils:

- `scripts/extension-workflow-reader-native-test.ts`: tatsächliches PostgreSQL am verwalteten Port 55433, eigene Datenbank und DATA, echte Store-ZIP-Installation sowie V1-API-Konfiguration von Eltern- und Kinddeklaration. V2-Zeilen sind ausdrücklich SQL-Protokollfixtures, kein Nachweis eines öffentlichen V2-Create.
- Der native Lauf prüft unveränderte V1-Pins, Eltern-/Kindgrenzen und die aktuellen geteilten Toolrechte sowie tatsächliche Provider-Assoziationen für beide Deklarationen und den Standalone-Slot. Außerdem: leere Auswahl gegenüber Vererbung, Standalone-only, Use ohne Manage, anderer Nutzer, Rechteentzug und beschädigte Header/JSON/Slotidentität. Ein Archivabruf, null MCP-/Geschäfts-/externe Netzwerkaufrufe; eigene DB/DATA anschließend unabhängig als entfernt bestätigt, eigener Listener geschlossen.
- Die isolierte Root-Paketprüfung verwendet den bestehenden PGlite-PostgreSQL-Adapter und eigenes DATA. Installieren, Veröffentlichen, Agent-/Sessiondienste, aktuelle Resource-Rechte und Paketdateien werden tatsächlich benutzt; Runtime-/Lizenzumgebung ist synthetisch. Eine reine Aufgabenbeschreibung ohne Skillnamen findet den Root-Skill. Deaktivierte und entzogene Ressourcen verschwinden; fremde Actor-Kontexte und kopierte Belege scheitern. Null Provider-Probes; eigene Testdaten bereinigt.
- Paketmasken, Standalone-Kontrollfluss und Renderer haben ergänzende fokussierte Regressionen. Bereits vorhandene Vertrags-, Paket-Workflow-, Toolmanifest-, Progressive-Gateway-, Provider-Policy- und Workflow-Integrationsprüfungen bestehen ebenfalls. Kontrollierte Authority-Dienste in Unit-Tests und PGlite bleiben vom tatsächlichen nativen PostgreSQL-Nachweis getrennt.
- Fokussierter Typecheck aller 33 geänderten TypeScript-Quell-/Testdateien einschließlich tatsächlicher importierter App-Abhängigkeiten und Ambient-Typen besteht. Temporäre Konfiguration `/private/tmp/canvas-extension-runtime-typecheck-20261014.json`; der einzige neu gefundene Test-Assert mit optionaler Fehlermeldung wurde korrigiert. Das ist kein vollständiger Repository-Typecheck. ESLint der geänderten Quelldateien und fokussierten Tests sowie `git diff --check` bestehen.
- Die geschützte Prompt-Ausgabe wurde mit dem tatsächlichen Collector, registriertem Read-Tool und bestehendem Progressive-Gateway gegen eigene Paketdaten geprüft: Fingerprint, Pin und Rootpfad stimmen überein; der File-Read erreicht die gehaltenen Bytes und die Discovery die aktuelle Quelle. Ein weiterer erlaubter geerbter Skill bleibt im allgemeinen Prompt ausgeblendet. Ohne Read-Tool gibt es kein Leserezept. Kopierte/fremde Kontexte scheitern vor dem Rendern.

Eine separate Annahmeschicht erzeugt nach aktueller Standalone-Prüfung einen opaken Turn-Beleg sowie einen strikt begrenzten privaten Datensatz ohne kurzlebige Account-Receipts. Der dauerhafte Syntaxvertrag prüft die genaue Übereinstimmung von öffentlicher Auswahl, privater Identität, Anforderung und Toolgrenze. Seine Regression verwendet echte Codecs mit kontrollierten Authority-Grenzen; sie ist kein zusätzlicher nativer Provider-Nachweis. Rehydration und tatsächliche Nutzung müssen Quellen und Rechte erneut prüfen; der private Datensatz oder sein Parser erteilen keine Ausführungsrechte. Der neue Einstieg lautet `npm run test:extensions:turn-acceptance`.

Der gemeinsame Collector und die geschützte Prompt-Ausgabe sind vorbereitet und mit derselben ausgegebenen Quelle geprüft. Der vollständige Anschluss an Live-Chat, Delegation und Automationen sowie die angenommene eigenständige Turn-Auswahl sind noch offen. Ebenso offen bleiben Agent-Tool/UI, Transport, Browser-/Modellabnahme und native Geräte. Schritt 2 ist deshalb weiterhin in Arbeit; kein vollständiger Planfall wird durch diese Grundlagen allein geschlossen.

## Laufzeitanschluss und genaue Paketverbindungen

Fortsetzung vom 14. Oktober. Live-Prompt, Skill-Readroots und Toolhinweise verwenden jetzt den ausgegebenen gemeinsamen Kontext; der finale Toolbestand bestimmt, welche Leserezepte oder Gateway-Aufrufe die Ausgabe nennt. Automationen und delegierte Worker erhalten denselben Compiler. Aktive Runs übernehmen einen neuen Selektionsstand erst gemeinsam beim sicheren Refresh.

Für ausdrückliche Turn-Verbindungen ist die Annahme von der aktuellen Runtime-Ausgabe getrennt. Der Übergang prüft die tatsächlich gespeicherte Session, Actor-/Workspace-Berechtigungen und jede genaue Quelle; öffentliche DTOs oder kopierte Handles ersetzen diesen Serverbeleg nicht. Kontext-Rekonstruktion erhält Auswahl, tatsächlichen Handle und Server-Turn-ID. Verlorene Quellen oder veränderte Rollen führen nicht zu einer allgemeinen Ersatzpolicy. Fest konfigurierte oder tatsächlich geprüfte explizite Auswahl nutzt den Integrationsgateway unabhängig vom globalen Experiment; unscoped General bleibt am Experiment gebunden.

`packageConnections` ergänzt ausschließlich die Nachrichtenhülle: genauer Paketpin, tatsächlicher Deklarationspfad, Capability/Alternative und ausdrücklich ausgewählte Verbindung. Die Syntax verlangt bereits ausgewählte Paket- und Verbindungsidentitäten einschließlich Revision; der Compiler prüft anschließend die gehaltene veröffentlichte Deklaration und aktuelle Quelle. MCP-Zuordnung liest die Vorlage aus den gehaltenen Paketbytes und vergleicht den aktuellen Endpoint/Prozess. Gleiche Namen und gemeinsame Anwesenheit eines Plugins und Accounts binden nichts.

Bestätigte aktuelle Teilnachweise:

- Neue Zuordnungs-Vertragsmatrix sowie bestehende Accepted-/Selection-Prüfungen bestehen: genaue Pins/Revisionen, doppelte oder fremde Slots, Quellen-/Toolkit-Konflikte, 128-Zuordnungsgrenze, Gesamtgröße, kein Aufnahmebeleg in der langlebigen Zuordnung und tatsächliche WeakMap-/Fingerprint-Übernahme. Sourceauthority ist in dieser isolierten Vertragsprüfung kontrolliert.
- `scripts/extension-turn-package-runtime-test.ts` besteht mit PGlite und anschließend tatsächlichem PostgreSQL am verwalteten Port 55433. Eigene Datenbank/DATA, wirklicher Store-Archivabruf, Installation/Veröffentlichung, Session, Actor, Lizenzprüfung mit eigener signierter Fixture-Lizenz und gemeinsame MCP-Source-/Use-Rechte; nur Modellkatalogmetadaten kontrolliert.
- Der tatsächliche Lauf prüft notwendige ungebundene Eltern-Anforderungen, ausdrücklich passende Zuordnung, gleichen Anzeigenamen mit falschem Endpoint, unbekannte/außerhalb liegende Deklaration und den Schnitt der Toolgrenzen. Ein einzeln gewählter optionaler Plugin-Skill behält notwendige Eltern-Verbindungen; seine lokale Anleitung bleibt verfügbar. Eine erste Prüfung reproduzierte das fehlende Elternmetadata und wurde nach Korrektur erneut erfolgreich ausgeführt.
- Zusätzlich: tatsächliche V1-Konfiguration über ihren vorhandenen Dienst, anschließend ausdrücklich gekennzeichneter V2-SQL-Protokollwrapper für einzelne Kinder. Ein erlaubtes B kann für den Turn statt Default A verwendet werden; Bindungsbytes und Benutzerpräferenzen bleiben identisch. Festes A darf nicht auf B wechseln. Dies beweist keinen öffentlichen V2-Create-/Update-Schreibweg.
- Frischer Use-Rechteentzug sperrt zuvor kompilierten Kontext. Null Provider-/Geschäftsaufrufe. Nach Fixture-Cleanup prüfen unabhängige Zugriffe die Abwesenheit der exakten noncegebundenen Datenbank und DATA. Der Testname „native“ bezeichnet PostgreSQL, keinen mobilen Client.
- `scripts/extension-integration-context-test.ts` besteht mit tatsächlichen PGlite Actor-/Session-/Workspace-/Source-/ACL-Diensten und wirklicher Annahme/Context/Gateway. Lizenz, Modellmetadaten und Provider-I/O sind dort kontrollierte Grenzen. Prüft tatsächliche Handle-Identität, endliche Quellen-/Toolmatrix, Klon/fehlende Quelle/fremden Turn, Rollenverengung, FlagOFF sowie späten Entzug vor Geschäfts-I/O.
- Fokussierter Typecheck von derzeit 52 Quell-/Testpfaden einschließlich ihrer tatsächlichen importierten App-Abhängigkeiten und Ambient-Typen besteht am zwischengeprüften Stand. Weitere währenddessen ergänzte Delegationspfade benötigen die abschließende gemeinsame Prüfung. Das ist weiterhin kein vollständiger Repository-Typecheck oder Produktionsbuild.

Die unabhängige Prüfung fand einen zusätzlichen Delegationspfad: Ein Worker konnte die genaue Standalone-Auswahl des Eltern-Turns verlieren und allgemeinere Quellen erhalten. Der neue Übergang verwendet einen privaten, SQL-task-/sessiongebundenen Serverbeleg und schneidet ursprüngliche sowie frische Elternpolicy mit Child- und Workergrenzen. Viele feste Agent-Bindungen werden nicht als erfundene fünfteilige Chat-Auswahl transportiert. Allgemeine Worker dürfen gehaltene Eltern-Paketquellen nur durch diesen Beleg und frische eigene Nutzungsprüfung übernehmen; feste Zielagenten behalten ihre eigenen Pakete.

Abschlussprüfung dieses Runtime-Teils am 14. Oktober:

- `test:extensions:runtime`, `test:extensions:turn-acceptance` und `test:extensions:turn-runtime` bestehen am gemeinsamen eingefrorenen Stand. Zwei alte kontrollierte Fixtures erhielten ausschließlich die erforderliche deklarative Metadaten-/Modellkatalog-Ergänzung; keine Source-/ACL-Autorität wurde dadurch behauptet.
- `scripts/extension-delegation-source-test.ts` besteht mit tatsächlichem PGlite Parent/Child/Task, verspäteter Queue außerhalb des ursprünglichen ALS-Kontexts und tatsächlicher Registry. Ursprüngliche und aktuelle Caps/Native-Grenzen, Task-/Actor-/Rollen-/Entzugsgrenzen, fehlende/geklonte Pointer, FlagOFF mit leerem Eltern-Workflow beziehungsweise sechs privaten Quellen bei leerer öffentlicher Chat-Auswahl, gehaltene veröffentlichte Elternpins, Skillgrenzen, erlaubte Zielalternative und disjunkte feste Slots geprüft. Keine Source-/ACL-Mocks, keine Modell-/Geschäfts-/externen Provideraufrufe.
- Die zusätzliche Composio-Handoff-Probe benutzt tatsächliche lokale SDK-/HTTP-Accountauswahl, Annahme, Parent-/Child-Source und genehmigtes Schema. Genau ein POST erreicht den gewählten Account am eigenen Fixtureprovider trotz FlagOFF; die externe Lizenzgrenze ist hier kontrolliert. Kein Produktionsprovider-Nachweis.
- Dispatcher-, Ephemeral-/Managed-Caller-, Integrationpolicy-/Gateway-/Handoff-, Automation- und Agent-Turn-Regressionen sowie die neue private Live-Start-Reihenfolge bestehen. Der Live-Ablauftest kontrolliert Autoritätsgrenzen und wird vom tatsächlichen Source-Test getrennt berichtet. Modellstart erfolgt erst nach gespeichertem Child-Turn, ausgegebener Source und finalem Prompt-/Toolbestand.
- Fokussierter Typecheck von **63** Quell-/Testpfaden einschließlich tatsächlicher importierter App-Abhängigkeiten und Ambient-Typen besteht; aktuelle ESLint-/Diffprüfungen bestehen. `npm run build` besteht einschließlich Next-Produktionskompilierung, dessen TypeScript-Prüfung und CLI-Versionseinfügung. Log: `/private/tmp/canvas-extension-phase2-build-20261014.log`. Ein eigenständiger vollständiger Repository-`tsc` wird dadurch weiterhin nicht behauptet.

Neue Einstiegspunkte: `test:extensions:turn-acceptance`, `test:extensions:turn-runtime` und `test:extensions:turn-package:native`. Wartende Delegationen ohne privaten Host-Beleg werden nach Prozessneustart vor Workerstart abgewiesen; die langlebige serverseitige Wiederaufnahme folgt ausdrücklich in Schritt 4. Kein Browser-/Modell-/Geräte-Abnahmefall wird durch die oben genannten Runtime-Grundlagen geschlossen.

## Dritter Teil: vollständiger öffentlicher Agent-Schreibweg

Stand 14. Oktober, nach Runtime-Commit `041d06308`. Create, Update und Inspect unterstützen jetzt die genaue gemeinsame Erweiterungshülle. API und Tool veröffentlichen dieselben strikten Feldverträge; ein vollständiger Erweiterungsstand wird nicht mit Legacy-Namenslisten gemischt. Omission bei Update erhält die vorhandene Konfiguration, eine leere feste Auswahl ist keine Vererbung. Der alte Paket-/V1-Schreibweg bleibt separat erhalten; V2 muss über die vollständige Hülle bearbeitet werden.

Die vollständige Erstellung speichert Profil, feste Paket-/Kindwahl, Standalone-Slots, Modellkonfiguration und Grants zusammen in einer SQL-Transaktion. Gemeinsame Verbindungen werden vor dem tatsächlichen Agent-Lock gesperrt und für dessen aktuellen Zielkontext autorisiert. Standalone benötigt Use, nicht Manage; eine neue Paket-MCP-Zuordnung behält ihre zusätzliche Mapping-Freigabe. Bei fehlgeschlagener Dateierstellung werden die SQL-Zeilen sowie genau die neue Definition und der Ersteller-Runtime-Ordner entfernt. Die Dateien anderer Nutzer oder anderer Agenten gehören nicht zu diesem Cleanup.

Eine neue persönliche Composio-Auswahl benötigt weiterhin den echten Accountbeleg. Unveränderte gespeicherte Auswahl wird für Edit über Agent-/Konfigurationsrevision, Slot, konkrete Identität und private Bindung erhalten und vor Schreiben frisch geprüft. Der Beleg wird nicht gespeichert. Read-only Inspect liest lokale Metadaten ohne Providerprobe; statische Lesebelege werden nicht zu Schreib- oder Ausführungsautorität erhoben. Die Ausgabe unterscheidet editierbare Konfiguration von Providerhealth, der hier unbekannt bleibt.

Der persönliche Choice-Pfad unterstützt V2-Standalone-Slots innerhalb der zentralen Allowlist beziehungsweise persönlichen Policy. Er ändert nur die eigenen Nutzerpräferenzen mit Workflow-/Preference-CAS. Feste Slots, fremde Erstellerkonten und nicht erlaubte MCP-Definitionen werden abgewiesen; zentrale Bindungen und fremde Präferenzen bleiben unverändert. Die bestehende Workflow-Antwort ergänzt sichere Standalone-Zusammenfassungen, ohne private Targets auszugeben. Edit-only darf Konfiguration lesen/speichern, erhält dadurch keinen Use-Zugriff; PATCH verlangt keinen nachgelagerten Laufzugriff.

Bestätigte Teilnachweise:

- Strikte API-/Tool-Adapterprüfung: vollständige vier Typen, Schema-Parität, feste/leere Auswahl, Vererbung, Omission, unbekannte/private Felder, gemischte Legacy-Eingaben und gegenseitig exklusive Nutzerwahl. Auth/Writer-Grenzen sind in diesem Adaptertest kontrolliert, keine SQL-Autoritätsbehauptung.
- Tatsächlicher PGlite- und anschließender nativer PostgreSQL-Writer mit eigener Datenbank/DATA, wirklichem Store-Archiv/Publish, Actor-/Ressourcen-/Source-Rechten und eigener signierter Lizenz: alle vier Typen, feste/auswählbare Standalone-Slots, echter SDK-Accountbeleg für B, unveränderte private B-Retention, Use ohne Manage, Zielagent-Grant, V1-Pin und notwendige Elternanforderung, Edit-only GET/PATCH, CAS, später Rechteverlust sowie mehrteiliger SQL-/Datei-Rollback bestehen. Native verwendet die vorhandene verwaltete PostgreSQL-Instanz 55433; kein neuer Container. Cleanup prüft die Abwesenheit der exakten eigenen DB und DATA unabhängig. Modellkatalog und SDK-Versionscheck sind kontrollierte Metadatengrenzen; null Provider-Business-/externe Aufrufe.
- Tatsächliche Standalone-Konfigurationsprüfung: Actor-/Workspace-/Target-/Revisiongrenzen, kopierte Handles/Snapshots/Batches, Zielagent-only Source-Grant, Entzug sowie fehlende, geänderte oder deaktivierte MCP-Definitionen. Diese MCP-/Inspect-Fixture hat null Provideranfragen.
- Tatsächliche persönliche Choice-Prüfung über API/Dispatch und SQL: zentrale Shared-Auswahl ohne direktes SourceUse/Manage, eigenes erlaubtes MCP, tatsächlicher SDK-Beleg für den zweiten Composio-Account, Source-/AgentUse-Entzug, Revision/CAS/Rollback, feste Slots und korrupte Org-Erstellerkonten, Erhaltung anderer Präferenzen und zentrale Konfiguration. Provider-Business null; externe Anfragen null zugelassen; ein automatischer SDK-NPM-Versionslookup wird vor Netzwerk blockiert und separat gezählt.
- Die Schema-Grenze berücksichtigt höchstens 128 verschiedene Shared-Verbindungen über alle Paketalternativen und Standalone-Choices. Geteilte Identitäten werden einmal gezählt; die separate Gesamtauswahlgrenze von 256 wird dadurch nicht allgemein reduziert. Retained-Targets werden zusätzlich bei tatsächlicher serverseitiger Auflösung und im SQL-Lockbatch begrenzt.
- Fokussierter Typecheck von **79** Quell-/Testpfaden einschließlich tatsächlich importierter App-Abhängigkeiten und Ambient-Typen sowie ESLint/Diffprüfungen bestehen. Die V1-Konfigurationssuite besteht; Management-Varianten bestehen bis auf die bewusst erweiterte Edit-only GET-Erwartung, deren aktualisierter Fall separat erneut besteht. `npm run build` für diesen vorbereiteten Backend-Stand besteht (Exit 0, `/private/tmp/canvas-extension-agent-writer-build-20261014.log`). Die neue Oberfläche ist noch nicht angeschlossen oder abgenommen.

Einstiege: `test:extensions:agent-configuration` und `test:extensions:agent-configuration:native`. Schritt 3 bleibt offen bis gemeinsame Prospective-Optionen, vollständige Tool-/UI-Bedienung und Kontextvorschau tatsächlich angeschlossen sind. Diese Backend-Prüfungen schließen keinen Browser-/Modell-/Native-Gerätefall der vollständigen Abnahmematrix.

Die anschließende read-only Planprüfung ergänzt konkrete Restfälle: vollständiger V2-Client-/Chooser-Roundtrip, Vorprüfung von Pflichttools und Kontextbudget, System-/Email-Scope und lesender Inspect sowie Dateibereinigung bei parallelem Create mit derselben ID. Diese Befunde sind im [Plan](chat-extension-reference-plan.md#restlücken-vor-abschluss-der-agent-stufe) mit Abnahmekriterien festgehalten und noch offen. Der neue Planungsschritt verändert keine Produktdateien. Ein erfolgreicher Produktionsbuild schließt diese Fälle nicht.

## Fortsetzung: Systemkontext und sicherer Agent-Lebenszyklus

Der erneut fortgesetzte Implementierungsauftrag schließt die Backend-Restfälle für System-/Email-Agenten und den Create-/Delete-Lebenszyklus. Auswahloptionen, UI, Kontextvorschau und Chat bleiben eigenständige offene Teile von Schritt 3 beziehungsweise 4.

- Neue V2-Systemkonfigurationen enthalten keine festen privaten Pakete oder Erstellerkonten. Die Email-Migration verwendet einen privaten Nachweis mit tatsächlichem Ziel, aktueller Organisation, SQL-Batch und Transaktions-ID; persistierte Email-V2-Bindungen benötigen ebenfalls den aktuell gehaltenen Batch. Nach Commit/Rollback, bei anderen Verbindungen, geklonten Nachweisen, fremder Organisation und Rechteentzug wird abgewiesen. V1-Pakete sowie bestehende User-/Vererbungsfreigaben bleiben erhalten.
- Gewöhnliche Email-Nutzer erhalten eine sichere Zusammenfassung und tatsächlichen freigegebenen Zugriff, ohne zentrale Konfiguration oder private Retention-Daten zu bekommen. Die API- und echte gespeicherte Session-/Rechteprüfung sind in PGlite und PostgreSQL geprüft; Providerhealth bleibt ungeprüft.
- Public Create und Delete halten dieselbe normalisierte globale Identität über den bestehenden Kernel-Dateilock. SQL-Rollback allein beendet diesen Schutz nicht: die Dateibereinigung gehört zum geschützten Ablauf. Ein zweiter tatsächlicher Node-Prozess prüft denselben Lifecycle-Lock; der zweite SQL-Create im Race-Test läuft im Hauptprozess über eine eigene tatsächliche Datenbankverbindung.
- Create bereinigt Dateien nur nach einem vom ursprünglichen SQL-Vorgang bestätigten Abort vor jedem Commitversuch und einer frischen Abwesenheitsprüfung. Bei unbestätigtem Abort, begonnenem Commit oder fehlgeschlagenem Abschluss bleiben Dateien erhalten; der öffentliche Fehler verlangt zuerst ein Nachlesen. Unsichere SQL-Verbindungen werden verworfen. Die Tests injizieren Antwortverlust nach tatsächlich ausgeführtem Commit beziehungsweise Rollback.
- Delete bestätigt die tatsächlich gelöschte Zeile einschließlich ID und Revision vor Sitzungs-/Dateibereinigung. Ein real eingeschobener konkurrierender Update erhält den Agenten, dessen Sitzung und Dateien. Eine frühere Löschbestätigung passt nach Neuerstellung derselben Agent-ID nicht auf die neue SQL-Zeilenidentität. Fehlende tatsächliche Lock-Infrastruktur ergibt HTTP 503 mit sicheren Angaben.

Frische Nachweise für den eingefrorenen Backend-Stand:

| Prüfung | Ergebnis und Grenze |
| --- | --- |
| `test:extensions:agent-configuration` | Sieben Script-Suites bestehen: strikte Adapter, gemeinsame Limits, Standalone-Konfiguration, vollständiger Writer, persönliche Wahl, Lifecycle und System-/Email-Kontext. Echte API-/Store-/SQL-/ACL-Pfade mit eigenen Daten; keine Browser-/Modellabnahme. |
| `test:extensions:agent-configuration:native` | Alle drei Suites bestehen mit tatsächlichem PostgreSQL auf dem vorhandenen verwalteten Dienst: vollständiger Writer, Lifecycle und System-/Email-Kontext. Jeweils eigene Nonce-Datenbank und DATA-Ablage; keine neuen Container. |
| V1-Konfiguration und tatsächliches Agent-Tool | Frische V1-Konfigurationssuite und Agent-Management-Toolprüfung bestehen. Der Tooltest verwendet die tatsächlich zurückgegebene Revision anstelle einer festen Annahme über die Anfangsrevision. |
| Statische Prüfungen | Fokussierter Typecheck von 86 Quell-/Testpfaden einschließlich tatsächlicher importierter App-Abhängigkeiten und Ambient-Typen sowie fokussiertes ESLint und Diffprüfung bestehen. Kein eigenständiger vollständiger Repository-Typecheck behauptet. |
| Produktionsbuild | `npm run build` besteht für diesen Abschlussstand mit Exit 0: Next-Produktionskompilierung, Build-TypeScript-Prüfung und CLI-Versionseinfügung. Kein Containerbau oder Deployment. |

Logdateien: `/private/tmp/canvas-agent-extension-final-suite-20261014.log`, `/private/tmp/canvas-agent-extension-final-native-20261014.log`, `/private/tmp/canvas-agent-extension-v1-regression-20261014.log`, `/private/tmp/canvas-agent-create-lifecycle-typecheck-20261014.log` und `/private/tmp/canvas-agent-extension-final-build-20261014.log`. Die später korrigierte Arbitrary-System-Testvorbedingung wird direkt im eigenen SQL-Datenbestand erzeugt und als tatsächlicher Systemagent nachgelesen; ihre PGlite-Prüfung und der vollständige Native-Lauf bestehen erneut. Die korrigierte fixture war nicht Teil der vorherigen ersten Suite; deren übrige sechs Suites bleiben unverändert.

Die lokalen Lifecycle-/Systemprüfungen schließen keine Auswahloberfläche, keinen Tool↔UI-Roundtrip und keine Modell-/Native-Geräteabnahme. Der nächste konkrete Schritt ist der gemeinsame Optionsdienst mit Konfigurationsvorschau und eigenem Use-only-Choice-Modus; danach folgt der gemeinsame Editor in den tatsächlichen Settings-/Chat-Eltern samt Workspace-Kontext.

Die abschließende Staging-Wirkungsanalyse dieses Backend-Teils umfasst 31 Dateien, 67 indexierte Symbole und einen betroffenen Runtime-Prozess; die aggregierte Einstufung ist mittel. Die vorherigen gezielten Analysen der Rechte-/Fehlerpfade meldeten zusätzlich HIGH beziehungsweise CRITICAL und wurden vor den Änderungen benannt. Neue noch nicht indexierte Module wurden über tatsächliche Aufrufer und die oben genannten API-/SQL-/Runtime-Prüfungen geprüft; eine leere Graphantwort galt nicht als Wirkungsnachweis.

## Gemeinsamer Optionsdienst für Agent-Tool und spätere Oberfläche

Der Optionsdienst verwendet einen gemeinsamen strikten Vertrag für `search`, `package_version`, `connection_choices` und `preview`. Er prüft den tatsächlichen Nutzer-/Workspace-/Organisations-/Projektkontext sowie den noch nicht gespeicherten Zielbereich oder die echte Agent-ID mit aktuellen Revisionen. Ein eigener `user_choice`-Kontext erlaubt ausschließlich die vom tatsächlichen Agenten vorgegebene persönliche Wahl; zentrale Edit-Daten und globales Durchsuchen gemeinsamer Verbindungen werden dort nicht ausgegeben. Es entstehen keine provisorischen Agenten, Sessions, Freigaben oder Runtime-Belege.

Die API `POST /api/agents/extension-options` und die Agent-Tools verwenden denselben Dienst. Der Request ist begrenzt und die authentifizierte Antwort nicht cachebar. `list_agent_extension_options` liefert nur Metadaten und ist im Planungsmodus erlaubt. `list_agent_extension_accounts` verlangt eine ausdrückliche Profilwahl und ist kein Planungsmodus-Tool. Die Create-/Update-Tool-Schemas verwenden die vollständige Erweiterungshülle; öffentliche Schemas sind über `workflow-public-contracts.ts` ohne Node-/Crypto-Abhängigkeit browserfähig.

Die Suche verwendet den bestehenden Plugin-Katalog. Composio-Toolkit-Metadaten werden getrennt von Accounts und Toolschemas geladen. Bei Managed-Zugang ohne den vom Adapter benötigten bestehenden Profilkontext bleibt die Quelle mit Einrichtungsbedarf unvollständig; es wird keine Nutzerzuordnung erfunden. Die MCP-Inventur liest Konfiguration ohne deren mutierenden Repair-/Migrationsweg und prüft persönliche beziehungsweise geteilte Rechte frisch. Vorhandene zentrale ENV-Lesedienste behalten ihre eigene bestehende Import-/Migrationssemantik. Kataloganzeige bedeutet weder Account-Autorisierung noch Providerhealth.

Der Paketleser hält veröffentlichte Revision, Checksumme, tatsächliche Root-/Kind-Skills und Elternanforderungen. Paket- und Kindbilder werden aus genau diesem veröffentlichten Stand über eine authentifizierte passive Bildroute gelesen; fehlende oder nicht mehr zulässige Bilder fallen auf Initialen zurück. Neue Head-Versionen ersetzen keine gehaltene Quelle. Composio verwendet weiterhin seine Toolkit-Logos; MCP verwendet die vorhandene geprüfte Domain-Icon-Quelle, sofern deren tatsächliche Bild-Leserechte bestehen.

Die Verbindungsauswahl unterscheidet gewöhnliches Use, zusätzliche Paket-MCP-Zuordnungsrechte und persönliche Wahl innerhalb endlicher gespeicherter Optionen. Persönliche Accounts werden erst nach expliziter Profilwahl geprüft; eine von zwei aktiven Instanzen wird genau ausgewählt. Nach I/O werden Ziel, Quelle und Profil erneut geprüft. Vorschau und Paketnormalisierung erhalten Pflichtanforderungen und Toolgrenzen, ohne eine Runtime-Ausführungsfreigabe auszustellen.

Der abschließende Options→Writer-Anschluss liefert persönliche Paketziele serverseitig mit genauer Alternative und Accountbeleg. In der neuen vollständigen V2-Konfiguration und ihrer persönlichen Nutzerwahl ist ein frischer Accountbeleg auch bei genau einem aktiven Account erforderlich; vorhandene gehaltene Bindungen und echte No-auth-Apps benötigen keine neue Kontoentscheidung. Der ältere V1-Kompatibilitätsweg bleibt erhalten. Die No-auth-Vorschau unterscheidet den tatsächlichen Fall durch gezielte Toolkit-Metadaten des ausdrücklich gewählten Profils; sie lädt dabei keine Accounts, Tools oder Gesundheitsdaten. Widersprüchliche Shared-Quellen werden vor der Vorschauprojektion abgewiesen.

Der frische Gesamtlauf schließt auch den tatsächlichen Übergang der kopierbaren `packageBinding`-/`noAuthPackageBinding`-Werte in öffentliche Create-/Nutzerwahl-Writer und zurück in Inspect ein: persönlicher MCP, genau Konto B statt Konto A, Use ohne Edit und No-auth mit gespeichertem `connectedAccountId: null`. Im Managed-Zwei-Profil-Fall geht die echte HTTP-Abfrage an die ausdrücklich gewählte Profilidentität; fremdes Profil und profilfremder Cursor werden vor Nutzung abgewiesen. Der lokale MCP-Create fragt keine Composio-Accounts ab. Pflichtkinder werden im Writer nun wie im Chooser aus lokalen Metadaten und tatsächlichen Policies bestimmt, ohne einen globalen Provider-Readiness-Scan. Die finale TypeScript-/ESLint-Prüfung, die V1-Regressionssuite und der Produktionsbuild bestehen nach diesen Ergänzungen erneut.

| Prüfung am 14. Oktober | Ergebnis und tatsächlicher Umfang |
| --- | --- |
| `test:extensions:agent-options` | Alle neun aufeinanderfolgenden Script-Stufen bestehen: öffentliche Verträge/Browser-Plattform-Bundle, katalogreiner Composio-Zugriff, Inventur, Paketleser, genaue Bilder, Chooser, Preview, tatsächlicher Service/API und Agent-Tool. Eigene SQL-/Datei-/HTTP-Fixtures; kein Browser-/Modell-E2E. |
| `test:extensions:agent-options:native` | Alle vier Stufen mit tatsächlichem PostgreSQL auf dem vorhandenen verwalteten Dienst bestehen: Paketleser, Chooser, Preview, Service/API. Jeweils eigene Nonce-Datenbank und DATA-Ablage; keine neuen Container. „Native“ bezeichnet hier PostgreSQL, keine Mobile-Abnahme. |
| TypeScript und ESLint | Fokussierter Typecheck der neuen Options-/Routen-/Bild-/Testmodule einschließlich tatsächlich importierter Abhängigkeiten sowie fokussiertes ESLint bestehen. Der erste Chooser-Test-Typfehler wurde durch tatsächliche Revisions-/Union-Prüfung korrigiert; kein Defaultwert ersetzt die geprüfte Identität. |
| Produktionsbuild | `npm run build` besteht mit Exit 0 einschließlich Next-Produktionskompilierung, Build-TypeScript-Prüfung und CLI-Versionseinfügung. Kein Containerbau oder Deployment. |

Nachweislogs: `/private/tmp/canvas-agent-extension-options-suite-20261014.log`, `/private/tmp/canvas-agent-extension-options-native-suite-20261014.log`, `/private/tmp/canvas-agent-extension-options-final-lint-20261014.log` und `/private/tmp/canvas-agent-extension-options-build-20261014.log`. Der vorhandene MCP-Identitätstest konnte wegen einer bestehenden CJS-Exportgrenze in `pi-ai/compat` nicht starten und wird nicht als bestanden gezählt; die separate Member-/Runtime-Zugriffsprüfung besteht.

**Schritt 3 bleibt offen:** Die aktuelle Preview meldet ausdrücklich `runtimeReadiness: not_checked` und `providerHealth: unknown`. Ihr kleinerer Metadatenumfang enthält noch nicht alle tatsächlichen Toolrouten, Provider-Referenzen und Core-/Pflichtskills. Sie ist deshalb kein bestandenes endgültiges Save-Budget. Nächste Aufgaben sind das gemeinsame tatsächliche Registrierungs-/Kontextgate vor Commit sowie der vollständige Editor und die tatsächlichen Eltern-/Workspace-Anschlüsse. Chat-Picker, persistenter Nachrichtentransport und echte Web-/Modell-/Mobile-Abnahme bleiben anschließend erforderlich.

## Wirkungsanalyse und Veröffentlichung

Die Runtime-Moduserkennung hat vier direkte Aufrufer (Workflowprojektion, Integrationspolicy und zwei Tool-Registry-Einstiege) und wurde von GitNexus als kritisch eingestuft. Kontextnormalisierung, Submission-Identität und Nachrichtenpersistenz haben ebenfalls einen breiten Wirkungsbereich über Chat, Tool-Apps, Delegation und Automationen. Unbekannte oder nicht indexierte API-Routen gelten nicht als risikofrei. Vor jeder bestehenden Symboländerung bleibt deren konkrete Impactprüfung erforderlich.

Die Staging-Prüfung des zweiten Grundbausteins meldet 57 indexierte Symbole, 36 Dateien und sieben betroffene Prozesse mit hohem Risiko. Sie betreffen die erwarteten Workflow-/Paket-, Registry- und Rechtepfade; neue noch nicht indexierte Module wurden zusätzlich über tatsächliche Aufrufer und Regressionen geprüft. Live-Prompt, Submission und Nachrichtenpersistenz sind in diesem Grundbaustein noch unverändert.

Dieser Auftrag erlaubt Implementierung und E2E. Ein neuer Docker-Testcontainer wird nicht vorausgesetzt. Ein späterer Testlauf verwendet einen frisch gebauten eigenen Node-Produktionshost und den verwalteten isolierten Test-Stack; fremde Instanzen und Produktionsdaten werden nicht umgebunden. Veröffentlichung über den bestehenden Feature-PR bleibt von Main-Merge, Release und Produktivdeployment getrennt.
