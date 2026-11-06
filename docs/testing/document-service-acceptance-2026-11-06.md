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
| Unterbrechungen und Wiederaufnahme | Release: drei ursprüngliche Migrationsvorgänge nach normalem Browseröffnen wiederaufgenommen, ursprüngliche Identität erhalten, alter Yjs-Zustand/Statevector bytegleich gesichert. Portable Übernahme am Stand `a489fa3e4` tatsächlich bestanden, siehe unten. | Unterstütztes Backup/Restore derselben Instanz sowie tatsächlichen Verlust der COMMIT-Antwort und Prozessabbruch mit nachfolgendem Status/Recovery pro betroffener Schreibfamilie belegen. Vorhandene Domänentests zunächst zuordnen; keine blind wiederholte Mutation. |
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
