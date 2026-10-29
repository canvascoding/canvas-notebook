# Interne Dateisystem-Bestätigungen und originale Agent-Wiederaufnahme

Produktbasis: `c79c75204f1588537fed2b5da842d8c8c620f4e7`.

## Verhalten

Während der ersten Publikation prüfte jede interne Bestätigung des Dateisystem-
Helfers erneut die vollständigen Rechte-, Registry-, Receipt- und Native-Daten.
Die reale Publikationsverbindung hielt dabei bereits die Auth-/Workspace-Sperren.
Im vorherigen Stand zeigte die erste `temp_synced`-Bestätigung vier Native-Leser
und vier mit der Agent-Autorisierungsphase markierte Abfragen.

Die feste Quelle unterscheidet jetzt ausschließlich fünf tatsächliche interne
Bestätigungen des originalen privaten Helferaufrufs: `temp_synced`,
`prepared_durable`, `target_linked`, `born_durable` und `complete_durable`.
Der private Aufrufkontext bindet Aktion, Bestätigung, Lebensdauer und die Identität
des ursprünglichen Eingabeobjekts. Kopien oder von einem Aufrufer gewählte
Stage-Strings können diesen Zustand nicht auswählen. Das Datenprädikat liefert
weder einen Principal noch Schreib- oder Native-Zustandsautorität.

An diesen Bestätigungen bleiben die wirkliche gehaltene Publikationsverbindung,
die synchrone Phasen-/Deadline-Prüfung, der tatsächliche Dateivorgang-Owner, die
Quelle, die gepinnten Wurzeln und die Prüfung auf ausstehende Dateioperationen
erhalten. Die vollständige frische Rechte-/Native-Prüfung erfolgt weiterhin vor
jedem Helferaufruf, bei `before_link`, unmittelbar am wirklichen `parent_link`
und nach dem tatsächlichen Helferabschluss. Finale Verifikation, beide
Deskriptorschließungen und der frische abschließende Principal bleiben erhalten.
Python-Protokoll, physische Publikation, Zeitlimits und Wiederholungen ändern sich
nicht; keine frühere positive Berechtigungsentscheidung ersetzt eine spätere
Schreibgrenze.

## Wiederaufnahme nach einem wirklichen Abbruch

Der neue Test entzog auf der gehaltenen Publikationsverbindung Rechte, nachdem
der öffentliche Dateilink existierte, aber vor erfolgreichem Abschluss. Der
Aufruf lieferte korrekt keinen Erfolg. Die Agent-Wiederholung scheiterte jedoch
vor Eintritt in den Dokumentservice an der allgemeinen Hardlink-Sperre: Die
Originaldatei besaß noch ihren beabsichtigten privaten Sicherungslink.

Der Agent prüft nun zuerst die Zielbeschränkungen und lässt anschließend den
vorhandenen zentralen Dienst die Originalanlage anhand derselben Operation,
Quelle und dauerhaften Belege prüfen und fortsetzen. Liefert der Dienst keine
Originalanlage, durchläuft ein gewöhnlicher Schreibzugriff vor Lesen/Ändern
weiterhin die vollständige Alias-/Realpfadprüfung. Es gibt keine allgemeine
Hardlink-Ausnahme und keine zweite Initialisierung der Originaloperation.

## Tatsächliche Prüfungen

`npm run test:documents:create:private-acks` verwendet registrierte Agent-Tools,
den echten MCP-Transport, PostgreSQL, den wirklichen Python-Helfer und physische
Dateien. Positive Treiber-/IO-Antworten werden nicht ersetzt.

Zehn Kontroll-/Abbruchfälle umfassen beide Aufrufer sowie Kontoentzug nach
`temp_synced`, einen Native-Sequenzwechsel nach `prepared_durable`, Kontoentzug
nach `target_linked` und nach `complete_durable`. Sechzig private Bestätigungen
wiederholen keine Native- oder tatsächlichen Sitzungs-/Kontoleser. Zehn
öffentliche Bestätigungen behalten diese Leser. Siebzig echte konkurrierende
Änderungsversuche auf einem anderen Backend scheitern an den gehaltenen Sperren.
Die acht tatsächlichen Änderungen auf dem Publikationsbackend verhindern eine
Veröffentlichung oder einen falschen Erfolg und werden zurückgerollt.

Originalzeilen einschließlich xmin, native Bytes, IDs, Lineage und ursprüngliche
Receipts bleiben beim Abbruch erhalten. Die explizite Wiederholung bestätigt
dieselbe Claim-ID, denselben Fingerprint, dieselbe Eingabe und denselben Inhalt.
Eine zusätzliche unbeteiligte Hardlink-Datei bleibt einschließlich ihres zweiten
Links, Inodes und Inhalts unverändert gesperrt.

MCP markiert seine aktuellen Slot-Leser nicht mit der Agent-Autorisierungsmetrik.
Der Test zählt daher zusätzlich die tatsächlichen Sitzungs-/Konto-SELECTs auf der
gehaltenen Verbindung; ein fehlendes Metriklabel gilt nicht als Prüfungserfolg.

Die drei vorhandenen Native-/Owner-/Publikationssonden erfassen ihre wirkliche
Publikationsverbindung nun bereits an der vollständigen Prüfung vor dem Spawn,
statt sie erst über eine entfallene private Zwischenabfrage zu finden. Ihre
89 Prüfaussagen sind bytegleich: Injektionsstelle, tatsächliche SQL-Mutationen,
Native-Proof-Anzahl, Rollback und Originalwiederaufnahme bleiben unverändert.
Alle 15 gezielten PostgreSQL-Suiten bestehen am gleichen Produktstand.
Release-Typprüfung, die gezielte Prüfung mit 34 Wurzeln / 5120 Quelldateien und
Lint bestehen ebenfalls. Drei vorhandene Produktfunktionen ändern sich, ein
privates Datenprädikat kommt hinzu; 279 andere Produktfunktionen bleiben bytegleich.

## Direkter Vorher-/Nachher-Vergleich

Vier frische Fixtures mit je zehn regulären Upload-Quellen schließen 16 Fenster.
Der Ausgangsstand wird aus seinem Git-Archiv mit eigenem nativen Addon gebaut;
Anwendungsbuild und Laufzeitdaten werden nicht kopiert. Alle eigenen Schemas,
Verbindungen, temporären Daten und der Ausgangscheckout werden danach entfernt.
SQL- und Pool-Zähler stimmen mit dem vorhandenen Treiberzähler überein; es gibt
keine fehlgeschlagenen Anweisungen oder am Ende offenen Abfragen/Verbindungen.
Unverwandte Native-Zeilen einschließlich xmin, physische Bytes und die Identität
der Originalwiederholung bleiben gleich.

| Messfenster | Vorher SQL / Ausleihen | Nachher SQL / Ausleihen |
| --- | ---: | ---: |
| Agent, erster Adapteraufruf | 1324 / 71 | 1264 / 71 |
| Agent, beide warmen Neuanlagen | 1219 / 37 | 1159 / 37 |
| Agent, Originalwiederholung | 168 / 7 | 168 / 7 |
| MCP, erster Adapteraufruf | 940 / 43 | 890 / 43 |
| MCP, beide warmen Neuanlagen | 919 / 30 | 869 / 30 |
| MCP, Originalwiederholung | 102 / 12 | 102 / 12 |

Die SQL-Anzahl sinkt bei jeder Neuanlage strikt; die vorhandenen Ausleihen und
Originalwiederholungen bleiben gleich. Laufzeiten dieser instrumentierten Läufe
sind nur Diagnosewerte. Das vorläufige Create-Budget von 200–500 Anweisungen ist
weiterhin nicht erreicht; abschließende Größen-, Latenz- und Parallelitätsvergleiche
bleiben erforderlich. Review Center und Undo sind im Vergleich deaktiviert;
`FILE_VERSION_CENTER_MODE=shadow` bleibt wie in den bisherigen Messungen gesetzt.

Die übrigen Regressions-, Mess-, Build-/UI-/Gesamtsuite- und Release-Nachweise
werden getrennt abgeschlossen. Dieser Bericht ist keine Gesamtabnahme. Review
Center und Undo werden nicht weiterentwickelt; alle übrigen Pakete des
Dokument-/Linkservice-Plans bleiben verbindlich.
