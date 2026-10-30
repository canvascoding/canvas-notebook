# Aktuelle Verbindungen und vollständige Dokumentoperationen

Produktstand: `6302d6403755e581f0eae9e83a10e1c016aa918c`; Diagnose-Commit: `a92945c8485db05e5ba5097e2afc963898ddf82c`.

Zwölf getrennte echte PostgreSQL-Fixtures liefern 42 Messfenster. Review Center,
Datei-Undo und Versionsaufzeichnung bleiben ausgeschaltet. Die drei vorhandenen
Create-Fixtures mit zehn Dokumenten wurden nach Prüfung identischer Produkt- und
Messquellen übernommen; ihre ursprünglichen Diagnose-Commits und Patch-Belege
stehen im JSON. Die übrigen neun Fixtures liefen nacheinander auf dem Diagnose-Commit.

Die Tabellen zeigen **SQL-Aufrufe / Pool-Ausleihen / gleichzeitig bereite physische
Laufzeitverbindungen**. Bereite Pool-Verbindungen zählen auch im Leerlauf. Ein
dedizierter Owner ist bereits in der Gesamtzahl enthalten; diese Spalten werden
nicht addiert. Verbindungsversuche und ausgeliehene Pool-Verbindungen sind andere
Messgrößen. Details der Kontrolle stehen im [Verbindungsnachweis](document-service-physical-connections-2026-10-30.md).

## Editor

| Prozessfenster | 10 Dokumente | 200 Dokumente |
| --- | ---: | ---: |
| Erste Sitzung, Socket und Projektion | 699 / 99 / 4 | 712 / 101 / 4 |
| 6.100 ms mit gehaltenem Owner | 817 / 158 / 7 | 766 / 146 / 8 |
| Erste warme Speicherung bis zur Datei | 420 / 87 / 5 | 410 / 81 / 4 |
| Zweite warme Speicherung bis zur Datei | 407 / 80 / 5 | 404 / 78 / 4 |
| Warme Sitzung und zweiter echter Peer | 733 / 104 / 4 | 749 / 108 / 4 |

Jedes Editorfenster enthält einen dedizierten Owner. Der Vergleich von zehn
und 200 Dokumenten verändert die Zähler nur wenig. Hintergrundzyklen laufen während
der Prozessfenster weiter; Unterschiede sind deshalb keine isolierte Wirkung der
Workspacegröße. Mess- und Stack-Erfassung beeinflussen Laufzeiten und damit auch
die Anzahl zeitgesteuerter Zyklen.

## Agenten- und MCP-Neuanlage

| Aufrufer und Größe | Erster Aufruf | Warm 1 | Warm 2 | Originalbeleg erneut |
| --- | ---: | ---: | ---: | ---: |
| Hauptagent, 10 | 1163 / 68 / 4 | 1058 / 34 / 4 | 1058 / 34 / 4 | 168 / 7 / 3 |
| Hauptagent, 200 | 1163 / 68 / 4 | 1058 / 34 / 4 | 1058 / 34 / 4 | 168 / 7 / 3 |
| Organisationsagent, 10 | 1336 / 68 / 4 | 1220 / 34 / 4 | 1220 / 34 / 4 | 194 / 7 / 3 |
| Organisationsagent, 200 | 1336 / 68 / 4 | 1220 / 34 / 4 | 1220 / 34 / 4 | 194 / 7 / 3 |
| MCP, 10 | 696 / 38 / 4 | 675 / 25 / 4 | 675 / 25 / 4 | 91 / 12 / 3 |
| MCP, 200 | 696 / 38 / 4 | 675 / 25 / 4 | 675 / 25 / 4 | 91 / 12 / 3 |

Auch mit ausgeschalteter Versionsaufzeichnung bleibt die Neuanlage teuer.
Die Arbeitsziele von wenigen Hundert SQL-Aufrufen sind damit noch nicht erreicht.
Die erneute Abfrage des ursprünglichen Belegs erzeugt kein weiteres Dokument.

## Umbenennen und Verschieben

| Vollständiger Ablauf | 10 Dokumente | 200 Dokumente |
| --- | ---: | ---: |
| Umbenennen, erster Lauf | 4054 / 376 / 4 | 19750 / 1238 / 4 |
| Umbenennen, warme Rückführung | 4047 / 372 / 3 | 19685 / 1216 / 4 |
| Verschieben, erster Lauf | 4180 / 378 / 4 | 19864 / 1237 / 4 |
| Verschieben, warme Rückführung | 4049 / 372 / 4 | 19698 / 1222 / 4 |

Die Größenvergleiche umfassen tatsächliche Vorschau, Auftrag, native Änderungen
und bestätigten Datei-Checkpoint. Die ursprünglichen Pfade und Verweise werden
anschließend geprüft. Die große Testmenge entsteht über den normalen
Upload-/Birth-/Projektionsweg; sie besteht nicht aus kopierten Datenbankzeilen.

Beim Umbenennen wächst die Abfragearbeit von rund 4.050 auf rund 19.700 Aufrufe.
Die Zahl gleichzeitig bereiter Verbindungen bleibt dabei bei vier. Die
Stackbelege zeigen wiederholte Storage-/Claim-/Current-Prüfungen und den
dokumentweisen Quieszenznachweis. Eine vorhandene Mengenprüfung dient der
Inspektion; sie ersetzt weder echte Raumwächter noch das Veröffentlichen der
einzelnen Nachweise. Bisherige Gruppen von acht bleiben deshalb unverändert,
bis ein eigener Bündelungsnachweis ihre Sperr- und Fehlergrenzen abdeckt.

## Einordnung und Grenzen

- Stackzuordnung und SQL-Zähler stimmen in jedem Fenster überein. Physische
  Beobachtungen sind vollständig; die eigenen Laufzeitverbindungen sind nach
  dem jeweiligen Prozess geschlossen.
- Originaldaten außerhalb der einzelnen Fixture, drei vorhandene Anker und
  die Identitäten aller 12 laufenden Container bleiben unverändert.
- Namen von SQL-Gruppen sind eine Textklassifikation. Ein kombinierter
  Berechtigungs-SELECT mit Katalogprüfung zählt beispielsweise als `catalogue`;
  dies macht ihn nicht zu einer ausschließlich technischen Katalogabfrage.
- Weiterleitende Fassaden wie `withLifecycleOwner` umfassen viele tiefer
  liegende Dienste. Ihre Gesamtzahl ist nicht allein der Aufwand einer
  einzelnen Berechtigungsentscheidung.
- Native Quellzustände werden bereits gebündelt gelesen: ein Header- und ein
  begrenzter Binär-SELECT je Durchlauf. Noch offen ist, unveränderte Inhalte
  anhand aktueller Belege nicht erneut vollständig zu übertragen und zu prüfen.

Backlink-Messung und Nachweise gleicher Ergebnisse über die tatsächlichen
Integrationsadapter stehen im [Vertragsnachweis](document-service-shared-contracts-2026-10-30.md).
Auch diese vollständige Matrix
schließt den [Gesamtplan](../document-write-database-performance-plan.md) nicht ab.
Weitere Bündelung, gemeinsame Änderungspfade, Leistungsgrenzen und Einführung
bleiben offen. Aus den Diagnose-Laufzeiten wird keine Produktionslatenz abgeleitet.

Maschinenlesbare Werte: [JSON](document-service-current-operation-matrix-2026-10-30.json).
