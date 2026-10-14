# Gemeinsamer nativer Sitzungsbesitzer im Serverprozess

Status: **Source-/PG-/Auth-Anschluss geprüft; neue kompilierte Mobile-/Browserabnahme offen.** Der Produktschalter bleibt deaktiviert. Diese Änderung schließt die konkret belegte Modulkopiengrenze aus der [Compiled-Mobile-Gegenprobe](./yjs-mobile-compiled-protocol-precondition-evidence.md), nicht die gesamte Yjs-Konsolidierung.

## Ursache und Änderung

Der erhaltene vierte Compiled-Mobile-Lauf erreicht echte Web-/Mobile-HTTP-200 mit derselben nativen Identität und danach `NATIVE_TRANSPORT_REQUIRED` im Raw-WebSocketserver. Die Next-Modulkopie und die Raw-Sourcekopie besitzen zuvor getrennte private Transport-WeakMaps; das unverändert weitergereichte opake Objekt wird in der zweiten Map nicht erkannt. Die erhaltenen V22-Artefakte wurden für diese Korrektur nicht verändert.

[authenticated-native-session-transport](../app/lib/collaboration/authenticated-native-session-transport.ts) verwendet jetzt einen nicht überschreibbaren Prozessslot mit eingefrorener, versionierter Methoden-API. Der erste Besitzer hält Maps, ALS, Fehleridentität und Busy-Set ausschließlich in seinem privaten Closure. Spätere Modulkopien delegieren Capture, Read/Diagnosis/Join, Ownerprüfung, Dispose und Fehlerprüfung an diesen Besitzer. Eine unpassende API wird abgewiesen; fremde oder geklonte Transportobjekte werden nicht adoptiert oder aus Snapshots neu geprägt.

Jede lokale Capturefunktion verlangt weiterhin ihre echte lokale `NextRequest`-Klasse. Der Besitzer kopiert URL/Methode/Headers synchron über echte Web-Request-/Headersintrinsics und erzeugt seine eigenen frischen Requests für die unveränderte Principalfactory. Getterattrappen und reine Prototypeobjekte ersetzen diese Bindung nicht. Readeroperationen und echte Reader-/Principalfehler werden ebenfalls zum Besitzer überbrückt; der Session-Service behält seinen eigenen Fehlerklassen-Fallback für seine lokalen Phasen. Nur qualifiziertes, vor dem Consumer entstandenes `PRINCIPAL_BUSY` mit bestätigtem Rollback/Close erhält den bestehenden begrenzten HTTP-Readretry.

## Exakter Sourceabschluss

Autorenworktree: `yjs-native-runtime-broker`, Basis `7202b4f86ac60eee9b7012b619caac332090c70b`, Commit `5f7150ac9eafb6dcf32c2633651c21742f20d348`. Genau drei Dateien:

| Datei | SHA-256 |
| --- | --- |
| `app/lib/collaboration/authenticated-native-session-transport.ts` | `2b02c079d1e57920e34b3e641c7ba78d7864ecd4c23ae5dd54786e9607e0e8db` |
| `app/lib/collaboration/authenticated-text-session-service.ts` | `94d52ffbfce077cf3fc190d4207a88b148b9f70403657f7361df3b4ae230cd80` |
| `scripts/authenticated-native-runtime-broker-postgres-test.ts` | `c2c9fa70e09f713d3fa609fa63bcfef807bf4685b285d449aa176382cd73c1f3` |

Root bestätigt diese drei Autorenbytes im Integrationsworktree. Der AST-Vergleich bestätigt 24 von 25 alten inneren Transportfunktionskörpern nach ausschließlich entfernter zusätzlicher Einrückung unverändert; nur `captureRequest` verwendet die neuen echten Intrinsics. Reader-, Principal-, Room-Owner- und Lifecycle-Module werden durch diesen Diff nicht geändert. Die gemeinsame API verändert die Modulzuständigkeit; die Körpergleichheit allein ist deshalb kein Laufzeitbeweis.

Root prüft vor Integration die 25 alten Funktionen, Errorclass und drei Servicefunktionen mit GitNexus. HIGH: Errorclass 26 direkte/80 erreichbare Symbole, Poison 13/39, Dispose 10/21 über Collaboration/Mobile/Server; Warnung vor Übernahme geliefert. Drei private Treffer sind als `partial` markiert; null indexierte Flows beweist keine vollständige Reichweite. Tatsächliche HTTP-/Mobile-/Raw-Socketcaller und die beiden Produktdateien wurden zusätzlich gelesen. Der gezielte Peerreview findet zuerst einen fremden Principalfehler, dessen lokale `instanceof`-Prüfung den sauberen Readretry verhindert; der anschließende echte Besitzerpredicate schließt diesen Befund.

## Tatsächliche Gegenproben

Der [Sourcecounter](../scripts/authenticated-native-runtime-broker-postgres-test.ts) läuft seriell in getrennten Prozessen mit beiden Erstbesitzer-Reihenfolgen, echten getrennten NextRequest-/Principal-/Reader-Modulkopien und PostgreSQL 18 am verwalteten Loopback-Endpunkt. Die Kopien ändern ausschließlich rückgeprüfte absolute Importbindungen. Jeder Lauf besitzt UUID-Schema und private DATA-/Modulkopieroots; negative Bootstrapimporte erhalten ebenfalls eigenen DATA-/Suchpfad vor transitiven Runtimeimports.

18 Familien je Reihenfolge bestehen: echte Requestmarken und immutable Credentials; Owner-Reader-/Fehlerbrücken; Readjoin/Quarantänediagnose ohne Writegrant; Plain/Clone und tatsächlich fremde Legacy-Capability; gemeinsames Dispose, Retained/Reentrant/Detached; Realm-/Schema-OID-/Fullscope-/Final-Revoke; echte bereits gehaltene Room-Ownerfences; qualifiziertes Busy. Die fremde Principalfehler-Gegenprobe ist vor Fix rot: tatsächliches 55P03, bestätigter Rollback und Holderfreigabe, aber Source-POST bleibt 409. Nach Fix erhält derselbe exportierte Web-POST 200 ohne Änderung von Native-ID/Sequenz/Proof oder gespeicherten Bytes. Fünf getrennte inkompatible Slots (Version, unvollständig, mutable, Accessor, zusätzliche Records) verweigern ohne Reset oder Aufruf fremder Methoden.

Root führt auf den übernommenen drei Bytes unabhängig aus:

```sh
NODE_ENV=test ./node_modules/.bin/tsx --conditions react-server scripts/authenticated-native-runtime-broker-postgres-test.ts
NODE_OPTIONS=--max-old-space-size=8192 ./node_modules/.bin/tsc --noEmit --incremental false
./node_modules/.bin/eslint app/lib/collaboration/authenticated-native-session-transport.ts app/lib/collaboration/authenticated-text-session-service.ts scripts/authenticated-native-runtime-broker-postgres-test.ts
```

Root: **36 echte PG/Auth/Source-POST-Familien plus fünf inkompatible Slots, Exit 0**, 110,2 Sekunden; cachefreies Full-TypeScript und Lint3 jeweils Exit 0. Der persistierte vollständige Rootlog hat SHA-256 `cb455d70a50f72f47a19f39022e6a1910efcbcc08cf3ea8e9fdc3b297ece96c8` (7.895 Bytes, privates Verzeichnis `/private/tmp/canvas-native-broker-root-pg-ppercsfj`). Root zählt darin ausdrücklich 18 PASS-Zeilen je Loadorder, beide echten POST-200-Zeilen, alle fünf Slotverweigerungen und den finalen Sentinel. Die ausgeführten finally-Blöcke schließen Pool und eigene Clients, entfernen exakt ihr UUID-Schema mit anschließender Namespace-Abwesenheitsprüfung sowie eigene DATA-/Modulkopieroots; jeder Childprozess endet bestätigt mit 0. Es wurde kein HTTP-Host oder Container gestartet.

Der Autorenbeleg ist eine private strukturierte Zusammenfassung mit tatsächlichen Toolsession-/Chunkreferenzen, kein nachträglich behaupteter Rohstdout-Log: SHA-256 `426b0e3c6955df6d133ff555e1519b611230738ff59fbbda47f8a29e58413092`. Autoren-Forceindex/Detect: genau drei Dateien, 137 Symbole, LOW. Der Integrationsabschluss erhält zusätzlich seinen eigenen frischen Index und vollständigen staged Scopecheck.

## Verbleibende Gates

Ein Source-POST ist kein echter HTTP-/Socket-/Browsernachweis. Der neue Stand braucht einen frischen Build und echte Compiled-Mobile-HTTP→Ticket-only-WebSocket-Synchronisation einschließlich Ticketreplay vor TTL und tatsächlicher Ownerfreigabe. Der getrennte Capture-/Join-Busy-Vertrag und die erneute ursprüngliche Browser-/Neustartmatrix bleiben offen. Erhaltene V20/V21/V22-Artefakte und vier private Compiled-Mobile-Fixtures bleiben unverändert; echte iOS-/Android-Geräteabnahme ist nicht behauptet. I-04-Veröffentlichung und deren bestätigter D-Lifetime-Rotfall sind ein eigener, noch nicht integrierter Anschluss.
