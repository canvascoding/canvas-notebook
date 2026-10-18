# Nativer Dokument-Edit: interner Owner und tatsächlicher Nachzustand

Stand 18. Oktober 2026. Der gemeinsame interne Dienst `app/lib/documents/edit-service.ts` verbindet den strikten ID-/Vollversionsvertrag mit der bestehenden Agentoperation-, Direktverbindungs-, Raum- und Persistenzkette. Die neuen öffentlichen Edit-Adapter und eine reine Operationsstatus-API sind noch nicht angeschlossen. Dieser Nachweis bestätigt keinen extern nutzbaren Pythonclient.

## Autorität und tatsächliche Mutation

Der Dienst sucht einen vorhandenen Auftrag vor erneuter Text-/Targetvorbereitung. Eine neue Operation bindet den kanonischen Request, Identität mit Lineage/Generation/Repräsentation/Schema, vollständige Inhaltsversion und tatsächlich aufgelöste ursprüngliche Attribution A. Aktuelle Autorität B entsteht ausschließlich aus echten Requestcredentials, dem aktuellen MCP-Token für `edit_knowledge_source` oder einer wirklichen PI-Invocation für `edit_file`. Ein leeres Objekt, kopierter Origin, gespeicherte alte Session oder serialisierte Vergleichsdaten vergeben keine Rechte.

Die privaten originalen Tokens/Principals verbleiben in ihren Factoryclosures. Ein prozessweit geteilter opaker Registereintrag ermöglicht den tatsächlichen Next-/Server-Bundleübergang; die aktuelle kurze B-Phase kann nur die feste OnConnection-Funktion öffnen. Kein B-Zugriff überlebt Warteschlange, Room-Acquire oder Store-/Disconnect-Wartezeit. Headerdaten werden auf der aktuellen B gelesen und diese Verbindung vor der anschließenden Raumvorbereitung geschlossen. Nach gehaltenem Workspace- und konkretem Raummutex werden die aktuelle Session und Rechte erneut geprüft. Vollständiger Versions-CAS und aktive B werden synchron vor den bestehenden Text-/Blockwritern geprüft, nochmals nach deren teurer Targetvorprüfung unmittelbar vor der Mutation.

Die additive Migration erweitert die bestehende Operationstabelle um nullable Original-/After-Belege und einen begrenzten privaten Binärpayload. SQL-Trigger erhalten Original, Scope und bereits gebundenen After/Payload unveränderlich; bisherige NULL-Zweige werden nicht nachträglich umgedeutet. Native Wiederholung nimmt die originalen Targets und Attribution an. Erneuerte echte Session B kann denselben Benutzer-/MCP-Client-/PI-Agentauftrag prüfen, ohne ursprüngliche Session A umzuschreiben.

Der tatsächliche Yjs-Nachzustand wird innerhalb der synchronen Raumaktion erfasst. Der private Vorbereitungsklon besitzt eigene Yjs-Uhren und liefert keinen Erfolgsbeleg. Ein Noop durchläuft denselben tatsächlichen Raum-CAS und erhält einen eigenen dauerhaften Beleg. Bei bereits möglicher Mutation und späterem Phasen-/ACKfehler trägt der Fehler dieselbe Operations-ID; Targets werden nicht erneut ausgeführt. Historische Recovery bestätigt gespeicherte löschungsbewusste Containmentbelege. Das ist ausdrücklich kein neuer Review-/Undo-Pfad. Alte Accept/Reject/Revert/Cancel-Aktionen verweigern native Originale.

## Native History

History verwendet den vorhandenen HistoryOnly-Ledger und Version-Content-Store. Erfasst werden echte `native-yjs-update-v1`-Bytes mit Hash, Größe, vollem Zustandsbeleg und nativer Version; gültige XML-/Blockinhalte benötigen keinen verlustfreien Markdownexport. Originale Benutzer erhalten `user`/`manual`, ursprüngliche Agenten `agent`/`agent_apply`; die erneuerte Session wird nicht zur ursprünglichen Quelle umetikettiert.

Die bestehende rohe Historygrenze von 1 MiB bleibt von der nativen Read-/Editgrenze getrennt. `over_limit`, deaktivierte History und Quota sind eigene Hilfsergebnisse und kein Widerruf bestätigter nativer Speicherung. Ein privater Savepoint rollt eine unvollständige Historyrevision vor einer Quotaantwort zurück. Original/After und tatsächliche Payloadheader/-bytes werden auf derselben geliehenen B geprüft; der Aufrufer besitzt COMMIT und Release. Wiederholte History bestätigt den exakten Inhalt und seine unveränderliche Bindung.

## Tatsächliche Prüfungen

Die neuen Tests laufen über den bestehenden ESM-Runner mit tatsächlichen Sources, installierten Yjs-/Tiptap-Konstruktoren, realen PostgreSQL-18-Verbindungen und echten lokalen Credentials. `npm run test:documents:edit` enthält dieselben vier einzeln ausgeführten Programme; die PG-Fixtures benötigen die bestehende private lokale Testkonfiguration.

| Prüfung | Tatsächliches Ergebnis |
| --- | --- |
| Native Vorbereitung auf den neuen Writerquellen | 8/8, Exit 0 |
| Aktuelle native Edit-Principals | 9/9, Exit 0; echte MCP-JWTs, SQL-Revoke/ACL, Scope/Tool, B/Realm/Lifetime, Ablauf nach synchroner Arbeit, erneuerte SID, Request-Bearer und gespeicherte PI-Invocation |
| Native History | 6/6, Exit 0; Plain/XML/Blocks, Binaryrekonstruktion, Attribution, unveränderte Original-/History-xmins, echte SQL55000-Guards, absichtlich initial arrangierte korrupte Payload, deaktiviert/über Limit und echte 500-Versionen-Quota |
| Tatsächlicher Edit-Owner im Serverraum | 6/6, Exit 0; echte Cookie-/Socket-/PG-Owner, tatsächlicher After statt Preview, alter Suchtext bereits verschwunden, erneuerte SID bei abgelaufener A, Noop, akzeptierter Peeredit zwischen Admission und finalem CAS, native-only XML/Blocks, kontrollierter SQL-ACKverlust nach tatsächlicher Mutation und gleiche Operations-ID ohne Replay |
| Bisherige Blockwriter / Blockadmission | 42/42 und 5/5, beide Exit 0 |
| Bisherige MCP-Create-Principals nach tatsächlicher additiver Migration | 8/8, Exit 0 |
| Finale cachefreie gezielte Typprüfung einschließlich drei neuer Tests | Exit 0 |
| Scoped-Lint der 21 Code-/Test-/Runnerdateien | Exit 0 |
| Vollständiges cachefreies TypeScript vor Hinzufügen der drei Tests, 6144 MiB | Exit 2, exakt dieselben 69 bytegleichen Bestandsdiagnosen, SHA256 `f87d64a219dd9317c7a22890a2687240cbf81b79851e829dd8117faa2ea561e3` |

Die drei negativen Historyläufe bleiben erhalten. Ihr zunächst zu knapper Stackfilter wurde zur Diagnose erweitert. Die konkrete Gegenprobe erfasst drei tatsächliche xmins `10925975` gegenüber erwartetem Parent-XID `10925974`: Ein echter Savepoint schreibt unter einer eigenen Untertransaktion. Das korrigierte Orakel erhält Backend/Top-XID, verlangt gleiche valide Zeilen-xmins und belegt über eine unabhängige Verbindung alle drei frischen Revision-/Binding-/Blobzeilen vor COMMIT unsichtbar sowie danach exakt gemeinsam sichtbar. Dafür wird ein zuvor nicht vorhandener Blobhash geprüft. Der Produktcode musste für diesen Fehler nicht geändert werden.

Der erste Produkt-Typecheck fand zwei Typfehler: explizite generische WeakMaptypen im neuen Register und Wiederherstellung des weiterhin agent-only Legacy-Markdownpatch-Origins. Der erste Test-Typecheck fand die vom Ticketaussteller selbst gesetzte Schemakonstante als unzulässigen Parameter sowie zwei ES2017-inkompatible BigIntliterale im später ersetzten XID-Orakel. Alle ursprünglichen Diagnosen bleiben erhalten; die finale gezielte Prüfung besteht.

Quellen, Originalausgaben und Ressourcenbericht liegen privat unter `/private/tmp/canvas-native-id-edit-root-ucsf83us/`. Die unabhängigen Quellenreviews der Root-Bridge und sechs Owner-/Historydateien melden keinen konkreten Blocker. Der neue Service und das stärkere COMMIT-Orakel wurden gesondert gelesen. Eine zusätzliche tatsächliche Abschlussprüfung bestätigt für alle acht eigenen PG-Fixtures einschließlich der negativen Läufe: Schema entfernt, keine zugehörigen Sessions, Datenordner entfernt und aufgezeichnete Original-PIDs abwesend. Der tatsächliche Raumtest bestätigt geschlossene Sockets/Server und seinen dedizierten Ownerbackend.

## Verbleibende Abnahme

Frischer Produktionsbuild und bestehende Create-/Editor-/OAuth-Browserregression werden separat ausgeführt und erst nach tatsächlichem Abschluss ergänzt. Sie können keine noch fehlende öffentliche Edit-Route beweisen. REST/MCP/PI/Mobile benötigen den expliziten neuen Adapter und begrenzten Ergebnisvertrag; reine Statusreads dürfen nicht den hier mutierenden Retry-/Durabilitypfad als Lesefunktion ausgeben.

Python-SDK und öffentliche Developer-Seiten unter `canvasnotebook.app/docs`, Standard-Skill, weitere Create-/PDF-/Sandboxanschlüsse, breitere Suchprovider und Gesamt-E2E bleiben im vollständigen Auftrag. Das SDK wird gemäß §4.0 im Notebook-Repository als eigenständig versioniertes Paket gebaut; öffentliche MDX-Quellen gehören nach `docs/product/en/developers/`. Allgemeine Aktivierung, Dateiaktions-Undo und Review Center bleiben aus. Kein Push, PR oder Produktionsrollout.
