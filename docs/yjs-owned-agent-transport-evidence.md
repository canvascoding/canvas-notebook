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
