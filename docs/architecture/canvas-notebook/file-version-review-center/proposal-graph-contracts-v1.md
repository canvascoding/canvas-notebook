# Proposal-Graph V1: Implementierungsvertrag

Stand: 2026-09-17

Task: `FVRC-1000`. Dieses Dokument fixiert die fachlichen Regeln fuer die
versionierten Contracts; die schrittweise Aktivierung folgt `FVRC-P10`.

## Drei getrennte Zustandsdimensionen

Der Lifecycle beschreibt, was mit einem Vorschlag entschieden wurde. Die
Auswertung beschreibt seine heutige Anwendbarkeit. Das Action-Receipt beschreibt
den Fortschritt einer konkreten Mutation. Keine dieser Dimensionen ersetzt eine
der anderen.

| Ausgang | Aktion / Bedingung | Ergebnis |
|---|---|---|
| open | Accept, gesamte Wirkung dauerhaft gespeichert | Ausgewaehlter Knoten applied; wirklich mit angewendete offene Vorfahren included |
| open | Autorisiertes Reject eines Knotens | rejected; offene Pflichtnachfahren bleiben vorhanden, Auswertung blocked_by_parent |
| open | Neuer expliziter Ersatz erfolgreich gespeichert | superseded; alte Pflichtnachfahren blocked_by_parent, keine automatische Umhaengung |
| open | Andere Option derselben Gruppe dauerhaft gewaehlt | alternative_not_selected; deren offene Pflichtnachfahren blockiert |
| open | Wirkung nachweislich schon vorhanden und explizit abgeschlossen | satisfied_elsewhere, keine neue Inhaltsrevision und keine automatische Gruppenwahl |
| open | Nicht mehr rekonstruierbar abgelaufen | expired; Nachfahren blockiert, Audit bleibt erhalten |
| Jeder terminale Lifecycle | Neuer Inhalt gewuenscht / Wiederaufnahme | Neue Proposal-ID auf nachgewiesener Basis; kein Wiederbeleben alter Aktionen |
| applied oder included | Spaeteres Revert oder Restore | Historischer Lifecycle bleibt wahr; offene Kinder pruefen die aktuelle Voraussetzung erneut |

`blocked_by_parent`, `prerequisite_lost`, `conflicted`, `unavailable` und
`stale_lifecycle` sind Auswertungsergebnisse, keine nachtraegliche Umschreibung
des historischen Apply-Belegs. Neue Auswertungen duerfen keinen Proposal-Inhalt
oder dessen Basisreferenz veraendern.

## Beziehungen und Wirkungsmenge

- Ein Vorschlag hat eine verifizierte autoritative Basis oder genau eine
  Proposal-Voraussetzung. Ersatzreferenz und Alternativgruppe sind davon
  unabhaengig. Eine Alternative zu einem Kind erbt dieselbe Voraussetzung.
- Die Pruefmenge enthaelt auch bereits angewendete Vorfahren und relevante
  Alternativgruppen. Die Schreibmenge enthaelt ausschliesslich die noch offenen
  erforderlichen Aenderungen, jeden Knoten einmal.
- Eine Ersetzung wird bei erfolgreicher Erstellung wirksam. Ihr spaeteres
  Reject macht das Original nicht wieder annehmbar. Fehlgeschlagene Erstellung
  veraendert weder Original noch Kinder.
- Gruppenwahl ist Teil der sichtbaren Wirkungsmenge. Ein Kind kann ueber seinen
  Vorfahren eine Alternative auswaehlen; eine Batch-Auswahl mit zwei Optionen
  derselben Gruppe ist unzulaessig.
- Ein `satisfied_elsewhere`-Vorfahre ist weder pauschal blockiert noch ein
  historischer Apply-Beleg. Sein Kind benoetigt einen aktuellen Wirkungsnachweis
  und eine kompatible, in der Vorschau explizite Gruppenentscheidung. Der
  fruehere No-op-Abschluss hat keine Alternative automatisch gewaehlt.
- Der Server prueft aktuelle Rechte fuer alle benoetigten Inhalte und alle
  direkt terminal zu veraendernden Knoten. Ein Kind verleiht keine Rechte fuer
  seinen Parent.
- Eine Weiterbearbeitung nach Rebase bindet zwei verschiedene Identitaeten:
  den unveraenderlichen authored-Kandidaten des Parents und den tatsaechlich
  gelesenen effektiven Kandidaten samt gepinnter Auswertungs-ID. Deren Hashes
  muessen nicht gleich sein. Der gespeicherte vollstaendige Yjs-Update und die
  Ankerzuordnung machen genau diese Basis nach Restart rekonstruierbar;
  Markdown, State-Vector oder Durability-Receipt allein reichen nicht aus.

## Freigabe, Persistenz und Retry

Eine Freigabe gilt fuer genau den angezeigten effektiven Kandidaten, die
angezeigte Aktionsmenge und den angezeigten Current-/Graph-Stand im aktuellen
Scope. Nach Aenderung ist eine neue Vorschau samt neuem Klick erforderlich.
Ein State-Vector allein genuegt wegen reiner Yjs-Loeschungen nicht als
Dokumentnachweis; Inhalt, Struktur und vollstaendige Zustandswirkung gehoeren
zur Pruefung.

Die Action-Phasen erlauben pending/applying, Warten auf Durability und
Recovery. Erst bestaetigter Erfolg erlaubt terminale Lifecycle-Aufloesungen.
Ein Timeout oder geschlossenes Dialogfenster ist kein Beweis fuer Abbruch.
Idempotenz wird durch serverseitige Receipts getragen, nicht nur durch
Single-Flight im Browser. Der Request-Digest bindet den Key an Scope, Aktion
und Payload. Abweichende Wiederverwendung wird abgewiesen.

Reines Ablehnen bleibt auch bei fehlendem Kandidateninhalt moeglich. Sein
Fence bindet Identitaet, aktuelle Berechtigung, Graphrevision und betroffene
Knoten, verlangt aber keinen erfundenen Inhaltsvergleich. Accept und
No-op-Abschluss verlangen dagegen einen nachweisbaren angezeigten Kandidaten.
Replace und Detach referenzieren explizit eine neu vorbereitete Proposal-ID;
der Ergebnisbeleg nennt diese ID, statt still einen bestehenden Knoten umzubauen.

No-ops erzeugen keine neue Inhaltsversion. Dokumentuebergreifende Batches und
neue Hunk-Teilannahme gehoeren nicht zu V1. Bei fachlichen Konflikten wird kein
Teil der Chain angewendet. Recovery nach Infrastrukturfehlern ist ein eigener
Contract und darf nicht als simple SQL-Rollback-Garantie dargestellt werden.

## Legacy und Rollout

Unabhaengige Legacy-Operationen benoetigen einen belegbaren Basis- und
Restumfang, bevor sie als vollstaendig offen projiziert werden. Teilweise
angewendete oder ungeklaerte Operationen werden nicht pauschal zu offenen Roots.
Die alten Mutationsrouten muessen vor Aktivierung der neuen Beziehungen deren
Graphbindung erkennen und den neuen Orchestrator verwenden oder sperren.

Dieser Contract allein schaltet keine Graphmutation frei. Erst die
Storage-, Mechanik-, Orchestrierungs- und UI-Gates aktivieren den Workflow.

## Verifikation

Die konkrete Contract-Suite und unabhaengige Fixtures pruefen gueltige
Kombinationen sowie falsche Version, unbekannte Felder, zu grosse Payloads,
ungueltige Referenzen und unzulaessige Zustandsdarstellungen. Semantische
Graphintegritaet und autorisierte Live-Mutation werden in den nachfolgenden
Tasks geprueft; ein syntaktisch gueltiger Request autorisiert keine Mutation.

Die Szenarien `PG-S03`, `PG-S05`, `PG-S08` bis `PG-S12`, `PG-S23` und `PG-S33`
sind fuer diesen Task als Contract-Fixtures festgelegt. Ihre Integrationstests
folgen beim jeweiligen Implementierungsschritt.
