# Raw-Copy: dauerhafte Originalbytes und Stage 6

Stand: 19. Oktober 2026. Ausgangscommit Root `38d6e47d3fce796875d28646905840ca7629c62d`. Der neue private Daten-/Speicherarm ist tatsächlich geprüft. Er enthält noch keinen öffentlichen Stage-6-Owner, keinen B1-Zielimport und keine B2-Veröffentlichung.

## Verhalten und Grenze

Stage 6 speichert den geprüften Managed-Plan 5, native/Scene-Originale und eine eigene feste `raw-originals.bin`. Deren vollständige Deskriptoren binden Reihenfolge, Requirement, Quellpfad, physische Identität, Originalhash, Größe und zusammenhängende Offsets. Einzelne Originale sind auf 4 MiB, ihr gemeinsames Binärpayload auf 64 MiB begrenzt. Manifestnamen werden nicht als freie Dateipfade verwendet. Der Decoder prüft die Deskriptoren vor dem Lesen und wiederholt tatsächlichen Parser, Importvorbereitung, FD-Blattbindung und Compiler-Replay.

`stageRawCopy`, `loadRawCopy`, `loadRawCopyByOperationId` und `removeCompletedRawCopy` verwenden denselben bestehenden privaten FD-Speicher mit Inode-, Eigentümer-, Modus-, No-Follow-, Hash- und Verzeichnisprüfungen. Die Originalbytes werden synchron vor dem ersten Speicher-Await kopiert. Ein Read übernimmt weder einen späteren Zielinhalt noch einen heutigen nativen Zustand als ursprüngliche Recoveryquelle.

Gespeicherte Daten und ausführbarer Ownervertrag bleiben ausdrücklich getrennt: `WorkspaceOperationStoredCopyStage` enthält 2–6, `WorkspaceOperationOwnedCopyStage` und `WorkspaceOperationAnyManagedCopyStage` behalten bis zum vollständigen Owneranschluss ihre bisherigen Versionen 2–5. Der vorhandene Ownerreader weist Stage 6 klar ab; der neue Raw-Reader liefert ausschließlich ursprüngliche Daten. Scene- und Phasenfreigaben bleiben unverändert. Der Metadatencodec akzeptiert Plan 5 zur Datenprüfung, seine mutierenden Phasen bleiben am bisherigen Owner gebunden.

Der erste gezielte Typcheck belegt die zuvor zu früh erweiterte globale Stage-Union mit sieben Diagnosen in noch nicht angeschlossenen Owner-/Phasenarmen. Die Korrektur trennt gespeicherte Stage-6-Daten von der noch ausstehenden Ausführung; keine Diagnose wird unterdrückt und kein Ausführungszweig durch einen Cast geöffnet. Alte Formate, Hashformeln und SQL bleiben erhalten.

## Tatsächliche Prüfung

| Prüfung | Ergebnis |
| --- | --- |
| Finales cachefreies gezieltes TypeScript und Scoped ESLint | Jeweils Exit 0, einschließlich neuem PG-Test |
| Neuer reiner Stage-6-Codec | Sieben Familien, Exit 0 |
| Echte PG18-/READ-only-/FD-/Storefolge | Sechs Gruppen, Exit 0; zusätzlich sieben Codec-Familien auf dem tatsächlichen Capture |
| Vier unveränderte vorhandene Stage-/Metadatenprogramme | 63 Node-Tests, keine Skips/Fehler |
| Bestehende tatsächliche Managed-Stage-Folge | Sieben Gruppen, Exit 0 |
| Bestehende tatsächliche öffentliche Mixed-Copy-Folge | Zehn Gruppen, Exit 0, einschließlich zentraler Links und verlorener Commitbestätigung |
| Unabhängige Ressourcenabschlüsse aller drei PG-Läufe | Eigene Schemas/OIDs, Backends, Daten und Originalprozesse entfernt; vier unveränderte gesunde verwaltete Dienste |

Die neue echte Folge verwendet die vorhandene gemeinsame Fixture. Zwei gewöhnliche, gegenseitig verlinkte Markdownquellen einschließlich BOM/CRLF und eine native Notiz werden mit tatsächlicher nur lesbarer Quellfreigabe erfasst. Die SQL-Beobachtung ist wirklich `READ ONLY`, behält denselben Backend und unzugewiesene XID und besitzt keinen DML-Adapter. FD-Vorbereitung und privater Speicher schreiben eigene Ziel-Temporärdaten; das ist kein vollständig schreibfreier Preview.

Nach jeder der sechs Gruppen werden alle Fixture-Schemazeilen samt `xmin`, das vollständige Quell-Dateiinventar mit Identitäten und Bytes sowie alle drei weiterhin uninitialisierten Raw-Originale geprüft. Auch bei einem Hauptfehler laufen diese Orakel weiter. Ab der dritten Gruppe bleibt zusätzlich die tatsächliche spätere Zieldatei D2 mit Inode und Bytes erhalten. Die Folge prüft Neustart ohne B0-Journal, fehlende/beschädigte Sidecars, Symlinks, Hardlinks, falsche Modi, unbekannte Zusatzdateien und synchrone Eingabekopie. Sie erzeugt keine Raw-Ziel-ID und keine künstliche Completion.

Die akzeptierte finale Typ-/Lint-/Pure-/PG-Folge erhält ihre sieben Quellenpins unverändert. Die Produktpins der vorherigen Bestandsprüfungen sind weiterhin identisch; nur der zusätzliche Test und sein fester Runnereintrag kommen später hinzu. Ein unabhängiger Quellenreview meldet keinen konkreten P1/P2 für den Stage-6-Daten-/Storearm. Das ist keine Gesamtfreigabe.

Private Originale: `/private/var/folders/bx/tjzzmjhn2qdcdyfc_l7hkv900000gn/T/canvas-m1-raw-copy-birth-z_ax5eva/`, Ordner `stage6-before`, `stage6-validation1` bis `stage6-validation3`, `stage6-regressions` und `stage6-managed-regression`. Der vollständige Quellen-/Artefaktindex liegt dort in `stage6-slice-acceptance.json`.

## Nächster tatsächlicher Anschluss

Owner und Phasen müssen nun Stage 6 mit aktuellem Principal übernehmen: alle echten Raw-Zielimporte und Vorkommensbindungen atomar in B1, danach native Linkrezepte, vollständige Reservierungen und Belege; FD-Veröffentlichung, B2-Graph/Katalog und Projektion sowie ursprüngliche Status-/ACK-Recovery müssen denselben Auftrag schließen. Die bisherigen öffentlichen Dateiaktionen und Produktionsaktivierung werden durch diesen Datenschnitt nicht erweitert. M1 und MVP bleiben offen.
