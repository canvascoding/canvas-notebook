# V22: Sessionantworten und verbleibende Peer-Autorisierung

Status: **Frischer Build bestätigt; originales Browsergate fehlgeschlagen und erhalten.** V22 prüft den begrenzten HTTP-Readfix und die gemeinsame Upload-Lifetime. Der [V21-Befund](./yjs-native-session-browser-busy-evidence.md) und die frühere bestandene V20-Abnahme bleiben getrennte Belege.

## Prüfstand

| Bindung | Wert |
| --- | --- |
| Privater QA-Worktree | `yjs-native-links/canvasstudios-notebook` |
| QA-Commit | `a1ffb8769a355565591f6f337456e3cac4401cd2`, auf Root `685ad1ac8` |
| Source-Fingerprint | `7504dfa49705c8f0a320af16d644078d991bda28311e03428a1a616e65a0c7f2` |
| Build-Fingerprint | `9fe2ebff8b65a99288d55c0eab329b01f0abdc6d0a820e868d76f9171a5a34fb` |
| Build-ID | `build-TfctsWXpff2fKS` |
| Control Plane | unverändert und sauber auf `27c8ce37da082244f006ca376068cde6b98845d5` |

Gegenüber Root ändert der private QA-Commit ausschließlich die eine Gatezeile auf `true`; Root bleibt auf `false`. Die ursprünglichen Browser-Specs, Runner, Reporter und QA-Helper sind bytegleich zum V21-Stand. Es gibt keine neue Installation, keinen Container und keine Änderung an V20/V21. Der einzige tatsächliche `npm run build` besteht. Root bestätigt vor und nach dem Browserlauf die tatsächlichen Source-/Artifact-/Build-ID-Bytes erneut.

Ein privater passiver Collector beobachtet den Build vor seinem Start: 197 Samples, 33 Cwd-Identitäten einschließlich Lesewerkzeugen, keine Beobachtungsfehler. Root beobachtet die tatsächliche Supervisor-/npm-/Next-Prozesskette unabhängig; ihre ursprünglichen PIDs und Gruppen sowie der Collector sind anschließend abwesend. Cwd-Snapshots allein erklären Lesewerkzeuge nicht zu Buildchildren; der erfolgreiche tatsächliche Childclose wird separat durch den Supervisor bestätigt.

## Originale Browserergebnisse

Ausgewählt bleiben die vier ursprünglichen Suites mit sechs Create-/Paste-/Import-, einem Fokus-, einem Link- und zwei Restartfällen. Die erste Suite startet sechs Fälle: **einer bestanden, fünf fehlgeschlagen**, keine Skips, Testtimeouts oder Unterbrechungen. Die drei weiteren Suites starten nicht; `restartCount=0`. Der gewöhnliche History-Fall besteht.

| Nativefall | Tatsächliche HTTP-/UI-Beobachtung |
| --- | --- |
| Homepage, erster Plain-Paste | Drei erfolgreiche `tiptap_blocks`-Sessionantworten für dieselbe Native-ID/Generation. Erster Clipboard-Paste, Native-Tree, folgende Tastatureingabe, getrenntes Undo/Redo und zweite Nutzeranmeldung werden erreicht; das Öffnen des Peers scheitert am Editorlocator. |
| Dateibrowser, erster Plain-Paste | Erfolgreiche `tiptap_blocks`-Session; Editor nach Create fehlt, erster Paste wird nicht erreicht. |
| Vollständiger Markdown-Upload/Source | Erfolgreiche `plain_text`-Session; der erwartete Sourceeditor wird danach nicht erreicht. |
| Markdown-Body-Insertion | Erfolgreiche native Session, danach zusätzlicher HTTP `409/PRINCIPAL_BUSY`; keine bestandene vollständige Einfügeabnahme. |
| HTML-Paste | Erfolgreiche native Session, danach zusätzlicher HTTP `409/PRINCIPAL_BUSY`; keine bestandene vollständige HTML-Pasteabnahme. |

Root bestätigt die Originalreporter und die selektierten Networkantworten unabhängig. Home-Peer, Dateibrowser und Vollimport enthalten außerdem tatsächliche Consolemeldungen `COLLABORATION_AUTHENTICATION_FAILED`; Home-Peer und Dateibrowser zeigen den erhaltenen Zugriffsprüfungs-/Backupzustand ohne Editor. HTTP-Erfolg allein bestätigt keinen erfolgreichen Socketjoin oder anschließenden Edit.

Der Hostlog enthält echte `AuthenticatedNativeSessionTransportBusyError` bei `beforeHandleMessage` und `connected` sowie einmal `onAuthenticate` mit `PRINCIPAL_BUSY`. Der Home-Dokumentname lässt sich dem bekannten nativen HTTP-Dokument zuordnen. Daraus folgt noch keine vollständige Zuordnung aller fünf Fehler, kein konkreter SQL-Lockhalter und kein Nachweis, welcher zulässige Retrypunkt jeweils erreicht oder ausgeschöpft wurde. Die Sourceprüfung zeigt: Der qualifizierte pre-Owner-Busyzweig vergiftet den Transport nicht. Eine pauschale Behauptung über einen dauerhaft vergifteten Transport wäre damit falsch. Kontrollierte Peer-/Capture-/Final-/Closegegenfälle sind vor weiteren Edits erforderlich.

## Abschluss und nächste Grenze

Die Fixture und Originaltraces bleiben unverändert erhalten. Root beobachtet live die tatsächlichen Notebook-/Issuer-Datenbanken mit OIDs `5927398`/`5938091`, Owner `canvas`, passenden Originalmarkern und gebundenen Root-/DATA-Identitäten. Nach Abschluss bestätigt seine eigene Read-only-PG-Prüfung jeweils null Sessions. Alle 39 im Runcollector erfassten ursprünglichen PIDs und zehn Leadergruppen sind unabhängig abwesend; eigener QA-Cwd ist leer und der Runtime-Lock fehlt. Der Supervisor belässt den fehlgeschlagenen Lauf korrekt auf `preserved`, `uncertain: true`, `passed: false`.

Der nächste Editor-/Sessionanschluss prüft die tatsächliche Peer-/Socketautorisierung getrennt vom bereits kontrolliert geprüften HTTP-Readfix. Browserassertions, Frontmatter-/Sourcegrenzen und Berechtigungen werden nicht abgeschwächt. Der genuine native Staging-Writer I-03b arbeitet parallel in einem anderen Worktree; seine neue Vollimportabnahme folgt nach dessen Integration. Ein separater kompilierter Mobile-HTTP→Einmalticket→Socketcounter wird vorbereitet und darf erst nach bestätigter Runtimeclosure seriell starten. Native-Mobile-Gerät, weitere Import-/Writer-/Batch-/Undo-Flächen und ursprünglicher Produktionsfehler bleiben offen.
