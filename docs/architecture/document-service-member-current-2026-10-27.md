# Dokumentservice: gemeinsame aktuelle Benutzerprüfung

Stand: 27.10.2026. Vergleich mit Produktstand `65f939b55823508d262e0e8a1fa92f10f150914f`.
Der [maschinenlesbare Bericht](document-service-member-current-2026-10-27.json)
bindet tatsächliche Produkt-/Testquellen, Ausgaben und Vergleiche per SHA-256.
Dies schließt einen weiteren Teil der Berechtigungsbündelung ab; Paket 2 des
[Serviceplans](../document-write-database-performance-plan.md) bleibt offen.

## Änderung und Berechtigungsgrenzen

Die normale Member-Current-Prüfung benötigt tatsächlich zwei statt acht
SQL-Treiberaufrufe. Sitzung/Token/Impersonation/Expiry, Konto, Seat, Workspace und
Berechtigungen werden zusammen mit der tatsächlichen Datenbank-, Schema-,
Backend-, Transaktions- und Relationsbindung gelesen. Eine vollständige frische
Abschlussbeobachtung bleibt erhalten; eine erneute Current-Prüfung liest beide
Beobachtungen erneut. Es entsteht kein Berechtigungscache und keine neue Autorität.

Feste, nicht materialisierte CTE-Aliase binden die vorhandenen Policy-Abfragen an
das zuvor gebundene Schema. Die Kontextbeobachtung prüft weiterhin den wirklichen
Suchpfad und die wirklichen Tabellen; ein abweichender Pfad wird nicht repariert.
Fehlende Relation/Spalte beziehungsweise Namespace führen zu den bestehenden
Principal-Schema-/Scope-Fehlern; eine abgebrochene Transaktion wird nicht wiederholt.
Die ursprünglichen reinen Seat-/Workspace-Entscheidungen werden wiederverwendet.
Von 61 bestehenden Funktionen der Principal-Datei ändert sich nur `current`;
die übrigen 60 einschließlich Agenten-, Job-, Gast-, Schema-, Sperr- und
Phasenmechanik bleiben bytegleich. Fünf Sekunden Lebensdauer und 50 ms
Sperrwartezeit bleiben bestehen.

## Nachweise

38 neue echte PostgreSQL-Fälle prüfen Lesen und Schreiben als normales Teammitglied,
Kontosperre, Sitzungs-Expiry/-Token/-Impersonation/-Entfernung, Seat-Entzug,
Workspace-Status/-Root, Rechteentzug, Suchpfad und fehlende/überschattete Tabellen.
Echte Änderungen zwischen den zurückgegebenen SQL-Antworten werden erkannt.
Reiner Schreibrechteentzug lässt Lesen weiter zu. Erfolgreiche Kontrollen und
zurückgerollte Fehlerfälle erhalten die geprüften Autoritäts-, Dokument- und
Metadatenzeilen einschließlich xmin. Positive SQL-Zeilen werden nicht ersetzt.

Zusätzlich bestehen die vorhandenen 66 Member-/Metadaten-, 35 Transport-,
23 echten WebSocket-, zwei Native-Room-, zehn Wartungs-, 60 Agent-Scope-,
30 Gast- und zwölf MCP-Path-Testfamilien. Der WebSocket-Test liest/transpiliert
seine echten Server-/Peer-Hooks selbst und läuft mit dem TSX-Loader; die anderen
genannten Tests verwenden den gebundenen Real-Source-Runner. Dessen zusätzliche
vorübergehende WebSocket-Registrierung wurde entfernt; per Lauf ist auch der
tatsächlich verwendete Runner-Hash gespeichert. Produkt-/Testquellen bleiben
für die erfolgreichen Nachweise identisch.

Release-TypeScript, die gesonderte Prüfung der Testquellen mit 36 Wurzeln und
5156 Quellen sowie ESLint ohne Warnungen bestehen. Das ersetzt keinen aktuellen
Produktionsbuild, Browser-UI-Test oder regulären `test:all`-Lauf.

Der feste Editor-Beobachter braucht jetzt 31 statt 43 Abfragen, die Callback-
Variante 43 statt 79. Der Test behält Ergebnis-/Unveränderlichkeits-/Negativprüfungen
und prüft nun absolute Budgets für beide Varianten sowie mindestens zwölf
eingesparte Aufrufe. Abschlussfenster-Tests treffen weiterhin die zweite/dritte
beibehaltene Current-Grenze, nun anhand ihrer vollständigen tatsächlichen Replies.

## Tatsächlicher Vorher-/Nachher-Vergleich mit zehn Quellen

Alle sechs Fixtures bestehen und schließen ihre eigenen Ressourcen. Die Zellen
nennen SQL-Treiberaufrufe / Pool-Ausleihen einschließlich Transaktionssteuerung.

| Ablauf/Fenster | Vorher | Jetzt |
| --- | ---: | ---: |
| HTTP: erster Einstieg und Öffnen | 103 / 12 | 91 / 12 |
| HTTP: warmes Öffnen, beide Wiederholungen | 100 / 9 | 88 / 9 |
| Editor: Sitzung, Socket und erste Projektion | 1143 / 111 | 765 / 110 |
| Editor: 6,1 Sekunden ohne Eingabe | 1390 / 223 | 1176 / 223 |
| Editor: Save bis Datei-/Native-Checkpoint 1 | 708 / 110 | 533 / 96 |
| Editor: Save bis Datei-/Native-Checkpoint 2 | 715 / 115 | 610 / 116 |
| Editor: zweiter echter Peer | 1256 / 126 | 859 / 126 |
| MCP: erster Einstieg und Neuanlage | 2618 / 50 | 2618 / 50 |
| MCP: warme Neuanlage, beide Wiederholungen | 2597 / 37 | 2597 / 37 |
| MCP: ursprüngliche Wiederholung | 129 / 12 | 129 / 12 |

Die HTTP-/MCP-Fenster schließen ohne offene SQL-Aufrufe oder Pool-Ausleihen.
Die Editor-Fenster enthalten gleichzeitige Hintergrundabfragen und lebende
Peers/Owner; auch an einer Fenstergrenze können Abfragen und Verbindungen noch
offen sein. Die eigene abschließende HTTP-/Socket-/Backend-/Schema-/DATA-Bereinigung
ist nachgewiesen. Die Fensterzahlen sind deshalb keine festen SQL-Budgets für
einen einzelnen Save. Alle Fenster haben null fehlgeschlagene beziehungsweise
nicht unterstützte Abfrageformen. Eine allgemeine Latenzverbesserung ist nicht
nachgewiesen: warmes HTTP liegt lokal vorher bei 66–77 ms und jetzt bei 73–82 ms;
die Editor-Saves warten in beiden Varianten ungefähr 2,8 Sekunden auf Projektion.

Die MCP-Neuanlage wird durch diese Member-Änderung nicht günstiger. Ihr hoher
Aufwand und der verbleibende Editor-Leerlauf bleiben eigene Optimierungsziele.
Die bisherige vollständige Agent-/MCP-10/200-Matrix gilt weiter für ihren
gespeicherten Produktstand `0a4036548`; dieser Nachweis behauptet keine neue
vollständige Matrix oder erfüllte Zielbudgets. Weitere gemeinsame Faktenleser,
Registry-/Zustandsbündelung, inkrementelle Links, normale Schreibwege und die
finalen Build-/UI-/Suite-/CI-/Recovery-/Release-Prüfungen bleiben erforderlich.
Review Center und Undo werden nicht weiterentwickelt. Produktionsdaten und
veröffentlichtes Release wurden nicht geändert.
