# Electron Workspace Drive

Stand: 2026-08-28

Dieses Verzeichnis ist die zentrale Planungsquelle fuer den lokalen,
bidirektionalen Workspace Drive der Electron-App.

## Dokumente

- `plan.md`: Produktziel, Zielarchitektur, Sync-Protokoll, Sicherheitsregeln,
  Edge Cases, Aufwand und Abgrenzung.
- `v1-pipeline.md`: verbindliche, sequenzielle Umsetzungspipeline mit
  Zwischenprodukten, Gates und Releasekriterien.
- `tasks.json`: maschinenlesbare Arbeitspakete, Einzelaufgaben,
  Abhaengigkeiten, Abnahmekriterien und Verifikationen.

## Verbindliches V1-Ergebnis

V1 verbindet genau einen Personal Workspace mit einem leeren lokalen Ordner.
Nach dem bewussten Verbinden synchronisiert die Desktop-App automatisch in beide
Richtungen, arbeitet offline weiter und setzt die Queue nach Reconnect oder
Neustart fort. Konflikte erzeugen sichere Kopien. Lokale Root-Loeschungen,
Massenmutationen, Rechteprobleme und aktive Locks fuehren niemals zu stillen
Datenverlusten.

V1 ist kein nativer Mount und enthaelt keine Team-/Projekt-Workspaces,
selektive Synchronisierung, automatische Text-Merges oder Platzhalterdateien.

## Ausfuehrungsregeln

- Pakete und Tasks werden in der Reihenfolge aus `tasks.json` umgesetzt.
- Das naechste Paket beginnt erst, wenn das Exit-Gate des vorherigen Pakets
  nachweislich erfuellt ist.
- Jeder fertige Paketstand erhaelt einen eigenen, fokussierten Commit.
- Neue Server- und Desktop-Contracts werden vor Implementierungsnutzung durch
  Contract-Tests fixiert.
- Die erste End-to-End-Vertikale ist read-only. Bidirektionale Writes werden erst
  freigeschaltet, wenn Journal, Snapshot und Recovery sicher funktionieren.
- V1 wird zuerst als Opt-in-Beta fuer macOS und Windows freigegeben.

## Verbindliche Querverweise

- `../team-workspace/07-filesystem-migration-and-write-policy.md`
- `../team-workspace/18-collaboration-and-file-conflict-policy.md`
- `../plan.md`
