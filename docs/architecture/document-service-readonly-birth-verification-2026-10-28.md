# Dokumentservice: Verifikation ohne Anlegen oder Reparieren

Stand: 28.10.2026. Voraussetzung für die strukturelle Bündelung interner
Leseaktionen aus Paket 2 des [Gesamtplans](../document-write-database-performance-plan.md).

Der bisherige Python-Helfer verwendete auch für `verify` den schreibenden
Store-Öffner. Dabei wurden eine fehlende Lockdatei, Store/Anker oder ein fehlender
Claim-Ordner angelegt. Ein gültiger unterbrochener Anker wurde durch Entfernen
seines privaten Twins vervollständigt. Damit war Verifikation keine rein lesende
Operation und konnte noch keine unnötige SQL-Phase ersetzen.

`verify` öffnet jetzt ausschließlich den vorhandenen Lock mit Leserechten und
einer gemeinsamen Kernelsperre. Der Anker muss vorhanden und abgeschlossen sein.
Ein unterbrochener gültiger Anker liefert `RECOVERY_REQUIRED`; fehlende oder
beschädigte Belege bleiben unverändert. Der Claim-Ordner wird ausschließlich
geöffnet. Die Verifikation schreibt, erstellt, entfernt und synchronisiert keine
Dateien. Der bisherige Writer bleibt bytegleich und verwendet weiterhin seine
bisherige vollständige Initialisierungs-/Reparaturlogik. Deren Standardaufruf
des Ankerprüfers behält die bisherige Behandlung.

Zwei bestehende Laufzeitfunktionen ändern sich, ein lesender Öffner kommt hinzu;
21 weitere Funktionen bleiben bytegleich. Die vorab ausgeführte Risikoprüfung
meldet CRITICAL mit unvollständigen/veralteten Graphzuordnungen. Der tatsächliche
Aufrufpfad und die unveränderten Funktionen sind zusätzlich per Python-AST und
direktem Quellvergleich geprüft. Es wurde noch keine SQL- oder Principal-Phase
entfernt und keine Berechtigungsprüfung gelockert.

## Nachweise

Die sechs bisherigen Storage-Fälle bleiben bytegleich. Neun neue Fälle prüfen
Verifikation bei vorhandenen sowie fehlenden/beschädigten Stores, Lockdateien,
Ankern, Claims, unterbrochenen Twins und fremden Pending-Dateien. Der Test verwendet
tatsächliche temporäre Verzeichnisse und gepinnte Deskriptoren. Passthrough-Spies
beobachten echte Systemaufrufe; positive Dateisystemantworten werden nicht ersetzt.
Snapshots prüfen sämtliche Bytes, Inodes, Verzeichniseinträge, Modi und relevante
Zeit-/Linkmetadaten. Schreibende Open-Flags, Write, Mkdir, Link, Unlink, Rename,
Fsync und Fchmod sind bei Verifikation ausgeschlossen.

Am unveränderten Stand `b0a6e2f3dd35e93c61b0a3530aaa8afd1f324d74` bestehen die sechs
alten Fälle; alle neun neuen Fälle scheitern am nachgewiesenen bisherigen Verhalten.
Die Korrektur besteht mit **15/15 Fällen auf macOS und Linux**. Der Linux-Lauf
verwendet exakt dieselben beiden Quellen in einem neuen privaten Testverzeichnis
des einzigen verwalteten Notebook-Containers. App-Dateien, laufender Server und
Datenvolumes werden nicht überlagert. Das eigene Testverzeichnis ist danach entfernt.

Acht tatsächliche PostgreSQL-Suiten bestehen: Verifikationsphase, Bereich/Beleg,
native Beobachtung, Owner, Agenten-COMMIT-Antwortverlust, native MCP-Anlage,
vollständige manuelle Anlage und authentifizierter Upload. Originaldaten und
explizite Wiederaufnahme bleiben durch die bestehenden Assertions geprüft. Die
jeweiligen eigenen Ressourcen sind geschlossen/entfernt.

Die SQL-Zahlen bleiben an diesem vorbereitenden Schritt unverändert. Die
anschließende Umstellung muss echte Leseaktionen von nativer Speicherung,
Veröffentlichung und abschließender aktueller Bestätigung unterscheiden und
Widerruf/Recovery erneut belegen. Leistungsbudgets, übrige Servicepakete und die
endgültigen Build-/UI-/Gesamtsuite-/CI-/Review-/Release-Gates bleiben offen.
Review Center und Undo werden nicht weiterentwickelt; Produktion ist unverändert.
