# Dokumentservice: gemeinsame Speicherphase für Agent und MCP

Stand: 27.10.2026, Vergleich mit `a1715b5af82e0a106da046f06cefd9029866b100`.
Der [maschinenlesbare Bericht](document-service-mcp-storage-phase-2026-10-27.json)
bindet tatsächliche Produkt-/Testquellen und Ausgaben über SHA-256. Dies ist ein
weiterer Schritt des [zentralen Serviceplans](../document-write-database-performance-plan.md).

## Änderung und Grenzen

MCP öffnete außerhalb der nativen Publikationsphase für einzelne Bestätigungen
des Speicherhelfers eigene Principal-Transaktionen. Im echten Basistest wurden
während eines `open`-Aufrufs zwei unterschiedliche Transaktionen beobachtet.
Eine konkurrierende Kontosperre blieb an dessen pausierter Bestätigung ungesperrt.

Der vorhandene Agentenablauf wird als private gemeinsame Mechanik verwendet:
Ein vollständiger Speicheraufruf behält seine tatsächliche Principal-Transaktion
bis zum Ende aller Bestätigungen und des Helferprozesses. Läuft bereits die echte
native Publikationsphase desselben Vorgangs, wird deren Verbindung weiterverwendet.
Jeder getrennte Aufruf prüft die Rechte wieder frisch. Die gesamte Neuanlage wird
nicht in eine einzige lange Transaktion eingeschlossen.

Die festen Quellenprüfer, Lifecycle-/Native-/Dateibelege und Berechtigungsprüfungen
an Bestätigungen bleiben erhalten. Fünf Sekunden Phasenlebensdauer und 50 ms
Sperrwartezeit bleiben bestehen. Gemischte Agenten-/MCP-Verbraucherphasen werden
abgewiesen. Es gibt keinen neuen DB-Zugriffstyp, keine gespeicherten Rechte und
keine Autorität aus dem zusätzlichen Speicherphasen-Callback. Dessen feste
Quellenprüfung verlangt weiterhin den echten privaten Coordinator und dessen
genaue aktuelle Invocation, bevor ein Store angelegt werden kann.

Nur drei bestehende Funktionen ändern sich: der delegierende Agentenhelfer,
die Auswahl des Callbacks im gemeinsamen Create-Engine und die feste Zulassung
des MCP-Quellentyps für diesen Callback. 108 weitere Persistenz- und 16 Birth-
Funktionen bleiben bytegleich. Die gemeinsame Phasenfunktion ist privat.

## Echte Fehler- und Wiederholungsprüfungen

Der neue Test läuft durch den tatsächlichen MCP-Transport mit echten Tokens und
unveränderten PostgreSQL- sowie Helferantworten. 68 Speicheraufrufe bleiben jeweils
auf einer beobachteten Transaktion. Vier konkurrierende echte Kontosperren werden
während neuer dauerhafter Bestätigungen mit `55P03` blockiert. Nach dem bestätigten
Ende eines Aufrufs wird die Sperre tatsächlich gespeichert; die nächste Phase liest
sie frisch und verweigert die Neuanlage ohne Dokument, Receipt oder physische Datei.
Mehrere echte Ablehnungs-/Close-Fehler können vom öffentlichen Adapter als
`MCP_INGEST_FAILED` maskiert werden; der Test prüft deshalb zusätzlich die real
neu gelesenen Sperrfakten und das fehlende Schreibergebnis.

Zwei Abbrüche verlieren nur die Antwort eines tatsächlich erfolgreichen COMMIT:
vor der nativen Geburt und danach vor der physischen Publikation. Die Auswahl
verlangt denselben Backend/xid, einen geschlossenen Helfer und keine Domain-DML.
Eine native Schreibtransaktion wird nicht als reine Speicherphase behandelt.
Der unbestätigte Backend wird verworfen, der Helfer nicht automatisch wiederholt.
Die explizite Wiederholung verwendet dieselbe Operations-ID und denselben
ursprünglichen Birth-Intent. Bestehende Dokument-/Lineage-IDs und vollständige
Bytes bleiben erhalten; beide Vorgänge werden anschließend bestätigt abgeschlossen.
Die zwei wiederverwendeten Intents benötigen keine neue dauerhafte Intent-Bestätigung.

Alle neun weiteren Suiten bestehen: Agenten-Speicherphase und COMMIT-Verlust,
native MCP-Neuanlage, manuelle Anlage, Upload, freie manuelle Quellenabwehr,
MCP-Create-Principal, native MCP-Copy-Owner und 132 MCP-Snapshot-Fälle. Alle eigenen
Fixtures schließen. Release-TypeScript, gesondertes TypeScript mit 43 Wurzeln/
5165 Quellen/keinen Diagnosen und ESLint ohne Warnungen bestehen.

## Vergleich

Die drei Fixtures laufen nacheinander: bisheriger MCP-Pfad, neuer MCP-Pfad und
Agentenvergleich, jeweils mit zehn regulär hochgeladenen nativen Quellen.
Die Produktdateien werden kontrolliert auf den alten Stand gesetzt und danach
bytegenau wiederhergestellt. Jeder neue Vorgang erzeugt genau ein Dokument mit
vollständigem nativen/physischen Inhalt. Vorherige Registry-/Lineage-/Native-/
Metadatenzeilen/xmin und Dateien bleiben erhalten. Die ursprüngliche Wiederholung
behält Dokument-, Lineage- und Operationsidentität.

| MCP-Fenster | Vorher: SQL / Ausleihen | Jetzt: SQL / Ausleihen |
| --- | ---: | ---: |
| Erster Einstieg und Neuanlage | 1997 / 50 | 1892 / 46 |
| Warme Neuanlage, beide Wiederholungen | 1976 / 37 | 1871 / 33 |
| Ursprüngliche Wiederholung | 102 / 12 | 102 / 12 |

Die warmen MCP-Läufe liegen lokal vorher bei 2,35 / 2,33 s, jetzt bei 2,26 / 2,30 s.
Der aktuelle Agentenvergleich bleibt bei 2180 / 46 warm und 180 / 7 beim Retry;
seine warmen Zeiten betragen 2,92 / 3,00 s. Alle Fenster enden ohne offene
Abfragen/Verbindungen und ohne fehlgeschlagene oder unbekannte Queryformen.
Externe Fetches bleiben null. Das sind begrenzte lokale Werte und keine allgemeine
Leistungs- oder kontrollierte Netzwerklatenzabnahme. Frühere 200-Quellen-Nachweise
behalten ihre eigene Quellenbindung.

Weitere Resolver-/Current-Wiederholungen und gemeinsame Registry-/Zustandsleser
bleiben offen. Die Abfrageziele sind weiterhin nicht erreicht. Gemeinsame Link-
Verträge, inkrementelle Zielabhängigkeiten, normale gemeinsame Schreibwege sowie
finale Build-/Desktop-/Mobil-/`test:all`-/CI-/Review-Prüfungen, Backup/Restore,
ursprüngliche Dokument-Recovery und Release/Deployment bleiben erforderlich.
Review Center und Undo werden nicht weiterentwickelt. Produktionsdaten und das
veröffentlichte Release bleiben unverändert.
