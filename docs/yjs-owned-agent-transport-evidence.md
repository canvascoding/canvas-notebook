# Begrenzter Modelltransport für die echte Agentenabnahme

Stand: 15. Oktober 2026. Diese Vorbereitung prüft den Modelltransport; sie nimmt weder die native Sandbox noch das SDK oder die Standard-Skill-Verfügbarkeit ab.

Der neue [Testmodell-Server](../tests/helpers/owned-agent-tool-model.ts) liefert vorgegebene Toolentscheidungen über echtes lokales HTTP/SSE. Der spätere Integrationstest verwendet damit den regulären authentisierten Agenten-Chat und die ursprüngliche Runtime. Der Modellserver vergibt keine Actor-, Paket- oder Dokumentautorität und führt selbst keine Dokumenttools aus.

`npm run test:pi:owned-tool-model` verwendet den installierten echten Pi-HTTP/SSE-Adapter. Vier Fälle bestehen:

- Verifikation, zwei aufeinanderfolgende Toolcalls mit tatsächlichen IDs/Argumenten und Ergebnisrückgabe sowie abschließende Antwort über den echten Adapter.
- Fehlende, wiederholte oder fremde Toolresultate dürfen den vorgegebenen Ablauf nicht erneut starten oder weiterführen.
- Ein Ergebnis vor seinem Assistant-Toolcall wird abgewiesen; derselbe unveränderte Turn kann danach korrekt abschließen.
- Bereits akzeptierte Ergebnisinhalte können beim folgenden Call nicht nachträglich wechseln; der unveränderte Verlauf bleibt ausführbar.

Die letzten beiden Fälle wurden unabhängig ergänzt und gegen den unveränderten ersten Helper ausgeführt: tatsächlich Exit 1, zwei bestehende Fälle bestanden, zwei neue Gegenfälle fehlgeschlagen (je HTTP 200 statt 409). Nach der engen Korrektur bestehen dieselben vier Tests. Der finale Testdateihash ist `55f4fff2fce199c00164cb99f93b3cb4a5141f8c900019d5c6286d2469882c58`, der Helperhash `0c24c0541d8a324e2db94a9beaf1bdd31c8d077b78dfc75e860d8bf206a7ac29`.

Requests, Bytes, Nachrichten, Turns und Schritte sind begrenzt. Die Tests prüfen auch idempotentes Schließen und die anschließend fehlende Verbindung. Der unabhängige abschließende Quellenreview meldet keine offenen konkreten P1/P2 für diese zwei Dateien. Vollständiges TypeScript ohne inkrementellen Cache sowie gezieltes ESLint bestehen.

Ein vom Testmodell gemeldetes `completed` bestätigt ausschließlich das gebundene Protokoll. Der anschließende echte Agentenfall muss getrennt die gespeicherten Server-Toolresultate, Kindprozessabschluss, aktuelle native Dokumentidentität und Zustand samt Löschungen, sichtbaren Editorinhalt und physische Projektion prüfen. Der Modellserver validiert die Toolargumente nicht gegen Produktschemas; das bleibt Aufgabe der unveränderten echten Runtime. Lokale Testresultat-Nachrichten im Transporttest sind keine Belege einer autorisierten Produktmutation.

YD-08S und YD-13S aus dem [Anschlussplan](./central-notebook-file-api-import-plan.md) bleiben offen. Kein Apphost, Browser, Container oder Produktionsziel wurde für diese Transportprüfung gestartet.

## Erster tatsächlicher nativer Sandboxlauf: noch keine Abnahme

Root `77cb1a529` und QA `e68b856b1` unterscheiden sich ausschließlich durch das bestehende private Sessiongate. Der frische originale Produktionsbuild sowie Vor- und Nachprüfung bestehen mit denselben Fingerprints. Originaler Sourcefingerprint: `d86e46282f1e569b6167eeb7eb4e5d2a9a611530b23eb0c25abbd864685d2686`, Buildfingerprint: `42ed1070f5f68b41fcdc00a7c226e4fea1fbadfb5f174f4c9d4b71851c9a4fb5`. Control Plane bleibt `27c8ce37d`. Der unveränderte Supervisor führt ausschließlich `native-markdown-sandbox.spec.ts` aus und endet tatsächlich mit Exit 1: ein Fall gestartet und fehlgeschlagen, keine Abnahme.

Beide Denial-Iterationen durchlaufen den echten authentisierten Chat, ein selbst erstelltes veröffentlichtes Paket und die originalen Node-/Python-Launcher. Je fünf tatsächliche direkte Mutationen werden am OS-Schreibschutz abgewiesen, Scratch funktioniert; Dokumentidentität, Zustand samt Löschungen, SQL-Sequenz und physische Datei bleiben unverändert. Der positive Pythonlauf erreicht die erfolgreiche SDK-Stdoutprüfung einschließlich `edited:true` und erneut gelesenem Zieltext. Danach stoppt die Testauswertung am fehlenden inline `details.toolResults`: Die reguläre Toolausgabeaufbereitung archiviert große Details. Die nachfolgenden unabhängigen positiven Browser-/SQL-/Datei-/ACK-Assertions wurden nicht erreicht und gelten nicht als bestanden.

Der eigene Fehlerbestand bleibt erhalten (`preserved`, `passed:false`, `uncertain:true`, DB/DATA nicht entfernt). Der bisherige normale Session-Cleanup hat dabei bereits Session und Toolausgabearchiv entfernt; diese konkrete Diagnosegrenze bleibt offen dokumentiert. Der neue Fehlerweg muss beides bis zur Diagnose erhalten. Unabhängig sind alle 15 während des Beobachtungsfensters erfassten PID-/Startzeitidentitäten und sechs eigenen Prozessgruppen beendet; Fixture-Port und Runlock sind frei. Das 1,5-s-Sampling begann nach Startup und erfasst keine vollständige Lebenszeit kurzlebiger Kinder. Es erfolgte kein Unseal.

Die Testkorrektur liest das vollständige Original über die vorhandene autorisierte Session-Toolausgabe-API, bindet dessen Referenz an den tatsächlichen Call und prüft alle Seiten sowie endgültige Bytes/Checksumme. Die kompakte Liveausgabe und gespeicherte Ausgabe bleiben separat überprüft; ein rekonstruiertes Original wird nicht als ursprüngliches WebSocket-Ereignis ausgegeben. Diese Korrektur ersetzt keinen positiven nativen Wiederholungslauf. Review Center bleibt im tatsächlichen Dokument-/Skriptfall deaktiviert; Produktionsdateien wurden nicht bearbeitet.

Die [Archiv-Contracttests](../scripts/owned-sandbox-tool-result-test.mts) bestehen mit 41/41: echtes lokales HTTP und Playwright-Requestkontext, Produkt-`readTextWindow` einschließlich UTF-16-Grenze, vollständige Originaldetails und die Gegenfälle für Referenzbindung, Checksumme, Vollständigkeit, Seitenfortschritt, Budgets und HTTP-Fehler. Das ist Transport-/Integritätsprüfung ohne Notebook-/PostgreSQL-/Autorisierungsabnahme. Der echte Browserfall muss denselben Reader anschließend mit seiner tatsächlichen Sitzung verwenden.
