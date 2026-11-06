# Dokumentservice: Abnahmeabgleich vom 06.11.2026

Dieser Abgleich ergänzt den [Gesamtplan](../document-write-database-performance-plan.md).
Er trennt tatsächlich ausgeführte Abnahmen von älteren Teilbelegen und noch
fehlender Zuordnung. Review Center und Undo bleiben außerhalb des Umfangs.
Ein offener Gesamtbereich bedeutet nicht, dass seine Implementierung fehlt.

## Aktueller Produktstand

- Release: `2026.11.6.3`, Produktcommit `0c67bce200f45011f91432b2684b05ec910909e0`.
- Image: `sha256:cb15ab89972c37b79522eacf77f635e8bad1b735d3bc207fbe18e27096b6f369`.
- Reiner Teststand: `5309898213218ad5c49427fd88eff3fae70170d5`, PR #222.
  Drei Testdateien unterscheiden sich; keine Produktänderung.
- Produktionslauf `eb590283-1e03-44e3-b893-c5a3a8a11815`: erfolgreich abgeschlossen
  am 06.11.2026 um 12:25:32 UTC, Update-Exitcode 0, frischer Heartbeat,
  gesunder Container und gesunde Anwendung. Agent um 12:25:54 UTC online.

## Zuordnung zu den verbindlichen Prüfbereichen

| Bereich aus Abschnitt 5b | Tatsächlich geprüfter Ausschnitt | Verbleibender Abschluss |
| --- | --- | --- |
| Zugänge und Verwaltung | Vier echte API-Key-Browserfälle am Release-Image. Älterer kompilierter OAuth-/macOS-Keychain-Lauf am Stand `ebd18d825`: tatsächliche Ausstellung, natürlicher Ablauf, Refresh und unabhängiger Prozess. | Einzelne Rechte-/Lebenszyklusfälle den tatsächlichen HTTP-/UI-Berichten zuordnen. Der alte OAuth-Lauf ist keine neue Produktionsausstellung. |
| Rechte und Isolation | Native API-/SDK-CI am exakten Produktcommit bestanden. Kompilierter REST-/SDK-Leselauf am Stand `9f109fe5e` verweigert gemischte Credentials, Schreibversuch mit Leseschlüssel sowie Admin-, Secrets- und Schlüsselverwaltung; Widerruf greift. | Alle Matrixfälle einschließlich laufendem Rechteentzug, Seat, Kontosperre, Instanz- und Toolgrenzen einzeln an echte Auth-/HTTP-Nachweise binden. Keine Ableitung aus einem einzelnen 401. |
| Navigation und Lesen | Release: fünf produktive Wurzelvorschauen und fünf begrenzte native Reads, alle dauerhaften Versionen und Projektionen aktuell. Ältere kompilierte 10-/200-Quellen-Messung für REST und installiertes SDK mit echter PostgreSQL-Latenz vorhanden. | Seitengrenzen, Unicode, leere Fortsetzungsseiten, Größen- und Versionskonflikte den einzelnen Suitefällen zuordnen; produktiver Smoke ist keine vollständige Inventur. |
| Erstellen, Importieren und Bearbeiten | Release: alle 40 Zusammenarbeitstests, Mailto Desktop/Mobil und drei Wiederaufnahmen bestehender Migrationsvorgänge. Native installierte SDK-/HTTP-Familien am Produktcommit bestanden. | REST-/SDK-/Agent-Schreibfälle, Originalimport, Idempotenz und Parallelität mit Inhalt, Identität und Links zeilenweise zuordnen. Browser-Edit beweist keinen vollständigen SDK-Write. |
| Dateioperationen und Links | Kompilierter Stand `2f85bb3c7`: Standardprofil mit sechs REST-/SDK-Copy-/Move-/Delete-Operationen, vier Gruppen eingehender Links, Schlüsselrotation, historische Status-/Recover-Zugriffe und unabhängige REST-Statuskontrolle. | Zweites Minimalprofil separat zuordnen. Titel, Aliase, neue/mehrdeutige Ziele und relativen Pfadwechsel gegen vollständigen Neuaufbau pro tatsächlich unterstütztem Transport abnehmen. Alte Operationsabnahme nicht als aktuelle Release-Komplettmatrix ausgeben. |
| Unterbrechungen und Wiederaufnahme | Release: drei ursprüngliche Migrationsvorgänge nach normalem Browseröffnen wiederaufgenommen, ursprüngliche Identität erhalten, alter Yjs-Zustand/Statevector bytegleich gesichert. Portable Übernahme am Stand `a489fa3e4` tatsächlich bestanden, siehe unten. | Same-Instance-Restore am Stand von PR #224 zusätzlich bestanden, siehe unten. Tatsächlichen Verlust der COMMIT-Antwort und Prozessabbruch mit nachfolgendem Status/Recovery pro betroffener Schreibfamilie belegen. Vorhandene Domänentests zunächst zuordnen; keine blind wiederholte Mutation. |
| Paket und Kompatibilität | SDK-CI `42188297151` am Produktcommit: zwölf frische Wheel-/Sdist-Profile auf Python 3.10.22 und 3.15.2, je 53 echte HTTP-/PostgreSQL-Gruppen pro Python, null Skips. Bundle-Wheel und -Sdist stimmen bytegleich mit dieser CI überein. | Native CI verwendet Quell-HTTP-Endpunkte und ist keine kompilierte Next.js-/OAuth-/OS-Keychain-Abnahme. Versionsmatrix und vorhandene tatsächliche Keychain-Belege getrennt führen. |
| Fehler und Leistung | Release: Linkindex bei 10/200 regulären Quellen, 35 SQL-Aufrufe je Request beim Browserabruf und bei den drei warmen Abrufen; keine beobachteten Query-/Poolfehler. Die Quellen enthalten keine Links. Ältere REST-/SDK-Latenzbelege vorhanden. | Vollständige Kalt-/Warm-/Schreib-/Recovery-Messung, feste Zeit-/Poolgrenzen und dominante verbleibende Ketten. Indexmessung ersetzt weder Linkmutation noch Save-/WebSocket-/Hintergrundmessung. |

Die gesamte Release-Suite besteht mit 333 regulären Fällen, 102 bestehenden
bedingten Auslassungen und 40 verpflichtenden Zusammenarbeitstests ohne Fehler.
Diese Summen ersetzen keine Zuordnung der oben geforderten Einzelgrenzen.

## Bereits bestandene portable Übernahme

`compiled-portable-transfer-e5275bd29b17-result.json` ist ein tatsächlicher
erfolgreicher Transfer, kein reiner Preflight. Der Bericht und der ausgeführte
Prüfpfad bestätigen:

- Regulären Export ohne Quellschlüsseltabellen und Secrets, anschließend
  regulären Upload, Dry-run und bestätigte Übernahme in die getrennte Zielinstanz.
- Automatischen Containerneustart und Invalidierung der vorherigen Zielsitzung.
- Erhaltene Zielinstanz und unveränderte Zielschlüsselzeilen einschließlich `xmin`;
  der Quellschlüssel wird auf dem Ziel abgewiesen.
- Erhaltene Dokument-IDs, Versionen, native Yjs-Bytes und Markdown-Linkinhalte.
- Tatsächlich erfolgreiches natives Bearbeiten und Anlegen nach Restore.
- Widerruf eigener Credentials und byte-/feldgenaue Wiederherstellung der
  geschützten lokalen Originale.

Produktstand ist `a489fa3e4bd6369748fd92832df67d6588e6c233`, nicht der heutige
Release-Commit. Seither ändern sich unter anderem Session-/Migrationspfade,
Kollaborationsclient und Container-Entrypoint. Eine pauschale aktuelle
Produktequivalenz wird deshalb nicht behauptet. Der fehlerhafte rohe Volume-Klon
und die erfolgreiche unterstützte portable Übernahme sind verschiedene Fälle;
der frühere Klonfehler ist kein weiterhin unbehobener portabler Restore-Fehler.
Ein Neuaufbau des bereits bestandenen Transfers ist erst bei einer konkret
betroffenen Prüfgrenze erforderlich.

## Installierte SDK-HTTP-Familien am Stand von PR #224

Die [maschinelle Zuordnung](document-service-sdk-http-evidence-2026-11-06.json)
bindet die sechs tatsächlich bestandenen HTTP-/PostgreSQL-Familien und deren
Log-Hashes an CI-Lauf `42222775763`, Produktstand `ff6d683be` und das installierte
Wheel. Beide Python-Versionen, 3.10.22 und 3.15.2, bestehen jeweils 53 Gruppen:
Lesen 4, Edit/Status 6, Create/Import 7, Copy 8, Move/Delete 21 und Originalimport 7.

Die ausgeführten Unterbrechungen umfassen verlorene HTTP-Schreibantworten bei
Edit, Create, Import, Copy, Move, Delete und Originalimport sowie verlorene
COMMIT-Antworten bei Copy und Move/Delete. Die jeweiligen Suiteberichte bestätigen
keine automatischen neuen Schreibversuche. Das ist ein bereits vorhandener
Nachweis, kein zusätzlicher Testlauf und keine bloße Ableitung aus Parserfällen.
Die Zuordnung ist auf API-Key-HTTP und echte PostgreSQL-Pfade begrenzt; sie ersetzt
weder die kompilierte Next.js-Abnahme noch OAuth, OS-Keyring oder die verbleibende
vollständige Rechte-/Linkmatrix.

## Wiederherstellung derselben Instanz mit installiertem SDK

Am 06.11.2026 besteht der tatsächlich gebaute Produktstand
`ff6d683be2a09a178a7410e1308ace1dc025dbf0` aus PR #224 diese zusätzliche
Abnahme. Der Merge `e07df827f8553778d9da55864a4d58871e32794c` hat denselben
vollständigen Git-Baum. Das geprüfte Linux-Image ist
`sha256:c57e2a4b30b8bc6d8be80ec21e58e4df83d05e73f903bf545e095cb708df879b`;
es ist nicht das bereits veröffentlichte Release-Image 2026.11.6.3.

- Frische eigene Instanzdaten im einzigen verwalteten Testcontainer; Anmeldung,
  MCP-Freigabe und API-Key-Ausstellung über die regulären APIs.
- Das frisch installierte SDK liest und bearbeitet ein natives Dokument vor dem
  Export. Der reguläre Export enthält weder API-Key-Tabellen noch Schlüsselwerte.
- Schlüsselrotation erst nach dem Export: alter Schlüssel verweigert, neuer
  Schlüssel führt eine tatsächliche abweichende Bearbeitung aus.
- Regulärer Upload, erfolgreicher Dry-run, bestätigtes `FULL_RESTORE` und
  automatischer Neustart desselben Containers. Kein manuell ausgelöster Neustart
  wird als Restore-Neustart gezählt.
- Vor der ersten Schlüsselverwendung nach Restore sind aktive und widerrufene
  Credential-Zeilen einschließlich `xmin` exakt erhalten. Die alte Session ist
  ungültig, der alte Key bleibt gesperrt. Dokument-IDs, Versionen, Yjs-Bytes und
  Markdown-Linkinhalte entsprechen dem Export; die spätere Änderung ist zurückgesetzt.
- Ein neuer SDK-Prozess mit dem rotierten Key liest den historischen Edit-Status,
  bearbeitet das wiederhergestellte Dokument und legt ein weiteres natives
  Markdown-Dokument an. Eigene Credentials werden danach widerrufen.
- Die ursprünglichen lokalen Daten, Zeilen einschließlich `xmin`, Dateibytes und
  Speicheranker bleiben unverändert; der ursprüngliche Stack läuft wieder gesund.

Verwendet wird das aktuelle CI-Wheel auf Python 3.14.3. Alle acht installierten
SDK-Module stimmen bytegleich mit Wheel und aktuellem Quellstand überein. Der
Schreib-/Status-Prüfer liegt bytegleich zur ausgeführten Version unter
`scripts/helpers/python_sdk_restore_probe.py`. Er erwartet seine Konfiguration
über stdin und ein installiertes Wheel in einer isolierten Python-Umgebung;
Credentials gehören nicht in Kommandoargumente oder ins Repository. Der Prüfer
allein führt keinen Restore aus; die obigen Restore-Schritte stammen aus dem
gebundenen verwalteten Containerablauf. Diese Abnahme ersetzt weder die übrige
Matrix noch einen erneuten vollständigen `test:all`-Lauf vor dem nächsten Release.

Zwei vorherige Versuche scheiterten im neuen Abnahmeaufbau: zunächst an einer
veralteten Dokument-ID-Erwartung, danach an der fehlenden MCP-Freigabe der frischen
Testinstanz. Beide Originalwiederherstellungen bestanden. Der dritte Lauf besteht
sämtliche Schritte; keine Produktprüfung wurde dafür abgeschwächt.

## Belegregister

Die folgenden JSON-Berichte liegen im privaten Abnahmearchiv. Es werden keine
Credentials, Inhalte, Datenbank-URLs oder absoluten privaten Pfade veröffentlicht.
Die Hashes binden die tatsächlich gelesenen Berichte, sind jedoch kein Ersatz
für deren Prüfgrenzen oder die noch fehlende vollständige Matrixzuordnung.

| Bericht | SHA-256 |
| --- | --- |
| `release-2026.11.6.3-final-acceptance-summary.json` | `4e3d4a70b5155bd82706418551d06679ff80f1865fedd8505ed49b72049d533a` |
| `release-2026.11.6.3-sdk-ci-audit.json` | `44642d4482168cb8a448f93be53cabb29353a779a7c70015ccc4f57b0c613749` |
| `release-2026.11.6.3-production-final-verification.json` | `632757317f62bd1e599a0555a2e0de43829acee1b6f8c9afe83f5f3752ac2986` |
| `release-2026.11.6.3-production-bounded-mcp.json` | `ee2286024579d16b5a6e67830d1b02e3c3038c008ab3ff56cfa7e444eefc7df2` |
| `compiled-portable-transfer-e5275bd29b17-result.json` | `a14855a0e4db480dae817158ea2c9ff3a8ab60368edd1e6e094da9bef751326e` |
| `compiled-api-sdk-operations-1793755216082-result.json` | `68ad1bcfb2e5e3d714d351b67665a4ec40ac9e3964216c6309a90bc96bbbd01a` |
| `compiled-oauth-sdk011-prepared-1793855048563-result.json` | `c3594edcc7b9b322e38627f5f2ea855a4d72e30ea98d22efc3ebc86a9e2f6cfc` |
| `compiled-api-sdk-latency-1793879360344-result.json` | `085f31946f253c9e0f47a7fa53db4b411037896f7418a029227ce0a8b8ff1c16` |

Zusätzliche Belege zur Wiederherstellung derselben Instanz:

| Bericht | SHA-256 |
| --- | --- |
| `compiled-same-instance-sdk-restore-1793973867150-result.json` | `dacd6f4cf93369a77ffffd884c94d3f78484f19e00e5e3ec3283d736ab2e1b63` |
| `same-instance-sdk-current-wheel-binding.json` | `21367d9066c1af4820a7800edc3bd11708a11549f65b09bbeb626ec446487cea` |
| `same-instance-sdk-restore-private-runner-hashes-20261106-attempt3.json` | `955a10ce060ac5e9ddba29eea958f6915f25001055c7057acadd2aba00e4bdf8` |
