# Temporäre native Lesesperren: HTTP-Vertrag und begrenzte erneute Prüfung

Ausgangsbasis: `a266413ad03831511729b9a8803a07635e1f6433`. Die Korrektur schließt einen unabhängig nachgewiesenen Read-Vertragsfehler. Sie behauptet nicht, die genaue Ursache des V9-HTML-Paste-Reloadfehlers zu kennen: Für dessen gespeicherten `ROOM_OWNER_BUSY`-Log fehlen Request-/Pfad-/HTTP-Korrelation und die tatsächliche URL.

## Verhalten und enger Umfang

Der externe Server-Reader kann beim finalen Room-Unload eine echte `CollaborationRoomOwnerError` mit `ROOM_OWNER_BUSY` zurückweisen. Ohne eigenen HTTP-Vertrag lieferte `/api/files/read` dafür 500 ohne maschinenlesbaren Code; der tatsächliche FileBrowser-/Explorer-/Store-Lader öffnete nach einem Versuch keine Vorschau. Eine separate reale lokale Prüfung verzögerter Workspace-Hydration öffnete korrekt und begründete keinen Hydrationspatch.

Nur `app/api/files/read/route.ts`, `app/lib/files/client.ts` und die neue reine `app/lib/files/read-busy.ts` ändern Produktverhalten:

- Der GET-Adapter erkennt ausschließlich einen vertrauenswürdigen In-Process-`Error` mit genauer `name`- und `code`-Marke. Dies funktioniert auch bei getrennten Server-/Next-Bundles mit unterschiedlicher Klassenidentität. Er liefert 503, `success:false`, `code:ROOM_OWNER_BUSY` und `Cache-Control:no-store`, nachdem die native Shared-SQL-Transaktion vollständig zurückgerollt/geschlossen wurde.
- Die bestehende Document-Queryfunktion des Dateiklienten prüft nur diesen exakten HTTP-/JSON-Vertrag über einen Response-Clone. Ein gemeinsam genutzter Transport startet höchstens vier echte Requests, mit abbrechbaren Wartezeiten von 100/250/500ms. Nach zwei Sekunden seit Empfang der ersten Busy-Antwort startet kein weiterer Versuch. Bereits laufende Requests haben dadurch **kein** behauptetes hartes Zwei-Sekunden-Limit.
- Bei andauerndem Busy bleibt die letzte echte Response mit lesbarem Body ein Fehler. Die bestehende Query-Signal-/Authpartition- und Consumer-Abbruchlogik bleibt erhalten. HTTP-Busy wird weder NetworkError noch terminaler409; es autorisiert keinen Zugriff auf alte gespeicherte oder physische Inhalte.
- Room-Hubs, Owner-Fences, Store, FileBrowser, QueryClient, `fetchDocumentQuery`, Auth-/Principal-Verträge und Office-Service/-Writer ändern sich nicht. Reguläre frische native Reads nach Room-Freigabe behalten ihren vorhandenen Yjs-Authority-Vertrag. Der separate Office-DOCX-HTTP-Klient erhält503 als Fehler weiter; eine neue Office-Retry-/UI-Umstellung gehört nicht zu diesem Paket.

## Nachweise und Grenzen

| Gate | Tatsächlicher Nachweis |
| --- | --- |
| Gemeinsamer Document-Query-/Dateiklient | Busy→200; genau4 Requests bei dauerndem Busy; jeder Consumer behält einen lesbaren Fehlerbody; ein abgehender Consumer beendet keinen benötigten Mitleser; Query-Abbruch und Authwechsel stoppen weitere Starts. Andere Status-/Payloadformen, OwnerLost/ScopeChanged/Unavailable und Quarantäne werden nicht wiederholt. Ein nach dem Startbudget zurückkehrender Busy startet keinen weiteren Versuch; ein bereits laufender später200 bleibt erfolgreich. |
| Tatsächlicher lokaler FileBrowser/Explorer/Store | URL-Lader öffnet nach Busy→200 die echte Vorschau; Exhaustion bleibt ein sichtbarer Fehler. Überholte Pfade/Workspaces veröffentlichen keine alten Inhalte; die ursprüngliche Workspace-ID bleibt in allen alten Requests gebunden. Eine ersetzte erwartete native Dokument-ID wird vom bestehenden Store-Guard abgelehnt und erhält aktuellen Inhalt/Draft. |
| Tatsächlicher Room-Unload + native GET + PG18 | Die bestehende echte Hocuspocus-/Server-/RoomOwnerRuntime-Fixture hält den finalen Store an. Native Bootstrap- und Export-GET liefern503; jede komplette echte Shared-SQL-Transaktion ist vor ihrer Antwort geschlossen. Ein separater SQL-Writer kann anschließend die echte exklusive Admission-Fence erwerben. Nach Freigabe persistiert der finale Store aktuelleYjsBytes; ein frischer GET200 exportiert diese Bytes bzw. liefert native Bootstrap-Metadaten. Dauerndes Draining beendet exakt4 Exportversuche ohne Fallback. |
| Isolierung und Cleanup | Eigener zufälliger Workspace, eigener zufälliger PG18-Schema mit exaktem OID/Owner-/Comment-Marker-Abgleich vor Cleanup; keine Public-Tabellenmutation. Eigene Checkouts/Sessions und Shared-Fences0, Schema entfernt; private Ergebnisdatei600 unter Verzeichnis700. Kein Host-/Issuer-/Browser-/Containerstart. |
| Bestehende Serverfixture | Die gesamte unveränderte Auswahl auf der a266-Ausgangsbasis: Exit0,43 PASS-Markierungen. Nach Ergänzung dieselbe gesamte Auswahl erneut grün. Vier ältere anders basierte Planbefunde werden nicht als aktuelle Ausnahmen verwendet. |

Die lokale UI-Fixture verwendet tatsächlichen FileBrowser, FileGrid/Explorer-ViewModel, PreviewDialog, Zustand-Stores und Document-Queries; Randdialoge/Transport und FileEditor-Darstellung sind kontrollierte Stand-ins. Sie belegt Loader-/Pfad-/Identitätspublikation, **keine** Tiptap-, native Undo-/Socket-, Geräte- oder Browserabnahme. Der PostgreSQL-Gate verwendet echte Native-Reader-/Katalog-/State-/Transaktions-/Locklogik und den tatsächlichen Hocuspocus-Server. Die OwnerSession der bestehenden Serverfixture bleibt simuliert; der finale Yjs-Store wird über deren Fixture-Persistenzadapter und einen tatsächlichen PG-Observer veröffentlicht. Daraus folgt kein zusätzlicher Nachweis echter PostgreSQL-Room-Owner-Akquisition oder des produktiven Owner-gebundenen PG-Persistenzservices.

## Reproduzierbare Source-Gates

```sh
npm run test:files:read-busy
CANVAS_FILE_READ_BUSY_TEST_ENV_FILE=/absolute/private/managed.env npm run test:files:read-busy:postgres
node --conditions=react-server --import tsx scripts/collaboration-room-owner-server-test.ts
npm run test:collaboration:native-file-read
node --import tsx scripts/document-query-test.ts
node --import tsx scripts/file-open-flow-test.ts
node --import tsx scripts/notebook-document-open-identity-test.ts
node --import tsx scripts/file-history-reopen-test.ts
npm run test:collaboration:offline
CANVAS_NATIVE_READ_TEST_ENV_FILE=/absolute/private/managed.env npm run test:files:native-docx-read:postgres
NODE_OPTIONS=--max-old-space-size=8192 node node_modules/typescript/bin/tsc --noEmit --pretty false
```

Die PG-Gates akzeptieren nur ausdrücklich gewählte private lokale Env-Dateien, PG18 auf Loopback55433 und `canvas_notebook`. Zugangsdaten werden weder ausgegeben noch gespeichert. Fehler-Injektionslogs und lokale Runtime-/KaTeX-Warnungen der bestehenden Suites bleiben erhalten; fehlgeschlagene Fälle werden nicht übersprungen.

Die vier ursprünglichen Browser-Suites samt Seeds, Assertions und90s-Fokuslimit bleiben byteidentisch. Der ganze tatsächliche V9-Build samt Seal/Provenienz wurde vor Branchwechsel privat archiviert; sein Ref und seine Fehlerbeweise bleiben erhalten. Dieses Sourcepaket braucht anschließend unabhängige Root-Integration, frischen echten Build und Seal sowie einen gesonderten START für V10. Hier findet keine erneute Browserabnahme oder Produktionseinführung statt.
