# Erste Veröffentlichung eines authentisierten Markdown-Imports

Stand: 14. Oktober 2026. Inaktiver interner I-04-Anschluss; Autorencommit `0d8727cceb4a637e94a511dd021e4fb1165b8132`, sieben Dateien. Root übernimmt ihn auf den bereits abgeschlossenen Verbindungsstand `2315c1c674ec2662bb906dabdd365dd89f987f89`.

Ein erfolgreicher nativer Import darf bei seiner ersten Dateiprojektion keine später erschienene fremde Datei übernehmen. Der zuvor echte rote Abbruchfall zeigte außerdem, dass ein angehaltener Helper nach Ende der tatsächlichen SQL-Autorisierung und Sessionwiderruf noch eine Datei veröffentlichen konnte. Beide Grenzen sind jetzt im internen Koordinator getrennt gebunden und geprüft.

## Veröffentlichungsvertrag

Der bestehende Originalrequest-Koordinator hält Upload-Session/File-Fences, privaten Attempt und tatsächlichen Workspace-Owner A bis zum vollständigen Abschluss. Die native Importtransaktion speichert ihren unveränderlichen Importreceipt und die Bindung des ursprünglichen physischen Claims zusammen. Native B-, Recovery-C- und Veröffentlichungs-D-Phasen verwenden die echte aktuelle Anmeldung. Ein verlorenes COMMIT führt zur Bestätigung des eigenen Receipts; der Inhalt wird nicht erneut importiert.

Der Pythonhelper bereitet ausschließlich private Records und die eigene Inhaltsdatei vor. Er hat keine Ziel-Linkoperation. Erst nach tatsächlichem Child-Close und vollständig abgearbeiteten Prüfungen veröffentlicht der Node-Parent synchron über die [gepinnten FD-Primitiven](./yjs-fd-publication-backend-evidence.md). Direkt davor werden Autorisierung, Native-/Sourcebindung, tatsächliche Uploadmanifest-/Partidentität, TTL, Root und benannte Eltern erneut geprüft. Ein striktes synchrones Zeitbudget liegt unter dem SQL-Phasenlimit; zwischen letzter Prüfung und Link gibt es kein Await und keinen wieder aufnehmbaren Child-Schreibauftrag. Dieser Vertrag ist keine verteilte SQL-/Dateisystemtransaktion und behauptet keine atomare Garantie gegen beliebiges Anhalten des Parents.

Das öffentliche Ziel wird exklusiv erstellt. Eine bytegleiche Peerdatei, anderer Inode oder ersetzter Elternpfad bleibt fremd. Der vorbereitete eigene Inode besitzt vor Veröffentlichung Mode 0644; private Records bleiben 0600. Die enge Helper-Nachbereitung prüft den veröffentlichten eigenen Inode und darf nur dessen bestätigten privaten Twin sowie eigene private Abschlussrecords bereinigen. Fremde Ziele werden weder entfernt noch ersetzt.

Checkpoint- und Revisionsbelege müssen zum aktuellen eigenen Native-/Dateistand passen. Ein noch nicht finalisierter Birth darf vom allgemeinen Hintergrundprojektor oder einer fremden Recoveryphase nicht übernommen werden. Ist ein Abschluss unklar, bleibt er offen und der native Commit wird erhalten; gewöhnliche alte/import-only Projektionen behalten ihren bisherigen Vertrag.

## Wiederanlauf des globalen privaten Stores

V2 bereitet ein einzigartiges privates Storeverzeichnis und einen vollständig synchronisierten Anker vor, bevor der feste Ankername exklusiv per Dateihardlink publiziert wird. Der Anker bindet DATAprofil, tatsächlichen Store-Namen/-Inode sowie genaue Pending-Datei/-Inode und private Profile. Ein Crash vor Veröffentlichung hinterlässt einen erhaltenen Orphan; ein späterer unabhängiger Versuch kann einen neuen Store vorbereiten.

Die Link→Pending-Unlink-Lücke wird ausschließlich anhand exakt derselben zwei Dateinamen, desselben Inodes, vollständiger identischer kanonischer Bytes und des 0600-/Zwei-Link-Profils abgeschlossen. Unbekannte Verzeichnisse oder Pendingrecords werden nicht durchsucht, übernommen, überschrieben oder gelöscht. Settled V1 bleibt ohne Migration lesbar; unbestätigte V1-Zwei-Link-Anker und individuelle unbestätigte Claim-/Recordlücken bleiben konservativ gesperrt. Vor nativer DML pinnt der Parent den tatsächlich bestätigten Anker; alle späteren Helper- und synchronen Veröffentlichungsprüfungen vergleichen ihn weiter.

## Unabhängige Root-Abnahme

| Prüfung auf dem kombinierten Rootstand | Ergebnis |
| --- | --- |
| Neue echte PostgreSQL-18-/Auth-/FS-Matrix | 14 Familien, Exit 0 |
| V2-Storeinitialisierung mit tatsächlichen Prozessabbrüchen und fremden Artefakten | 29 Familien, darunter 13 tatsächliche HardExit-Grenzen, Exit 0 |
| Bisheriger authentisierter Stagingimport | 15 Familien, Exit 0 |
| Bestehende Projektion-/Receipt-/Generation-/Rollback-Regression | Exit 0 |
| Cachefreies vollständiges TypeScript | Exit 0, 12 GiB Heap |
| Scoped ESLint/Python-Syntax und Diffprüfung | ESLint6 und Diff Exit 0; Python vom tatsächlich ausgeführten Helper geprüft |

Die 14er-Matrix prüft echte Bearer-/Cookieautorisierung, Lost-COMMIT/Rechteverlust, ursprüngliche Quellen-/Targetidentität, konkurrierende Peerdatei und Eltern-ABA, Helper-Close vor Parentlink, fehlenden Backend vor nativer DML, tatsächlich abgetrennten Uploadancestor, eigene Absturz-/Retrygrenzen sowie wirkliche Projektor-Auxiliary-Locks und Closefehler. Der neue unabhängige Import nach frühem Initialisierungscrash erhält den ursprünglichen Orphan unverändert.

Die echte Timeoutgegenprobe hält den Child per SIGSTOP an, bestätigt das Ende des tatsächlichen fünfsekündigen D-Backends, widerruft die tatsächliche Session und setzt den Child fort. Root bestätigt `targetPublished:false`, abgewiesene API und `finalized:0`; der ursprüngliche rote Fall bleibt getrennt erhalten. Die externen Rootprüfungen bestätigen danach die Abwesenheit von Node-/Child-PID, den zugehörigen SQL-Backends und eigener DATA.

Private originale Rootbelege: `canvas-i04-root-integration-ztui5lzv`. Log-SHA-256: PG14 `891947b282cdf2900d797affb689140a9fd41be8be0feea946730801e335b0a2`, alter PG15 `d538f266ceca9cff49c782fd1149991e24d7b2abbe813214a5fbedd09e8db614`, Initialisierung `af019d459c7267d24f4d7af26e6242887029032566c8ffc3ea094cc4b842a7e0`, Timeoutresult `d0642388efa238552ed9714110d332dcf083bf12d5217f87bdb26779f066d828`. Der private Initialisierungstest wurde für die unabhängige Ausführung ausschließlich auf den Root-Helperpfad umgebunden; er prüft dieselben 29 Fälle. Die Autorenbasis enthält in einer unveränderten Transportdatei eine alte Header-Tuple-TypeScriptdiagnose und beansprucht dort keinen Full-TS-Pass. Root bewahrt den bereits korrigierten neuen Transport und bestätigt Full-TS auf den kombinierten tatsächlichen Bytes.

Alle sieben Dateien sind bytegleich zum Autorencommit. 23 vollständige Rootmodule einschließlich Principal/Broker, Legacy-HTTP-Service, Lifecycle-, Owner-, Persistence-/Checkpointkern, Upload-Lifetime/-Service, FD-Backend, Produktschalter und Dependencies bleiben bytegleich. Die zusätzliche gemeinsame Projektionsprüfung ist vor Übernahme per exakter UID untersucht: zehn direkte/30 erreichbare Symbole, mittlere Reichweite, Checkpoint- und Recoveryprozesse. Zielabwesenheit hat vier direkte/acht erreichbare Symbole, niedrig. Der frische Root-Forceindex und vollständige Staging-Scopecheck bestätigen zehn Dateien einschließlich drei Dokumentationen, 199 Symbole, null indexierte Prozesse und grob LOW. Die tatsächliche gemeinsame Checkpoint-/Recoveryreichweite bleibt relevant. Der gesamte Branchvergleich gegen `main` umfasst 420 Dateien, 4.463 Symbole und 40 Prozesse, CRITICAL; diese Gesamtbewertung ersetzt keine gemeinsame Abnahme. Unvollständige Namensabfragen dienen nicht als Nullbeleg.

## Noch offene Anschlüsse

Keine Create-/Chunk-/Multipart-/MCP-Route wird durch dieses Paket aktiviert, kein Upload als abgeschlossen markiert und kein App-/Browser-/Gerätenachweis behauptet. Die tatsächliche Root-Abnahme läuft auf Darwin; Linux-FD-Grundlagen wurden separat geprüft und ersetzen keinen gemeinsamen Linux-Appnachweis. I-05 verbindet als nächsten Importanschluss einzelne neue Markdown-Dateien im vorhandenen Chunkweg; I-06 bindet manuelles Create, I-07 anschließend den unmittelbaren Editor-/UI-Weg. Deren vollständige Create/Paste/Import-, Restart-, Peer- und Exportabnahme bleibt verpflichtend.
