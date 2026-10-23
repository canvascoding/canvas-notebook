# Reservationstest folgt tatsächlicher Workspace-Lockreihenfolge

Stand: 19. Oktober 2026. Grundlage ist Root `e3a4ea5081910e31a553100645333daedcc59413`. Dieser Schritt ändert ausschließlich den bestehenden PG-Test und seine ESM-Runnerregistrierung. Produktregeln, Zeitlimits und fachliche Assertions bleiben erhalten.

## Ursache der bisherigen Testabweichung

Der Room-Owner nimmt den gemeinsamen Workspace-Mutationsguard vor BEGIN und hält ihn durch COMMIT. Die Reservation nimmt denselben Guard vor dem PG-Checkout. Der ältere Test wartete während eines absichtlich gehaltenen COMMIT-Gates auf einen neuen Reservation-Backend beziehungsweise auf `pg_blocking_pids`. Diese Beobachtungen widersprechen der bestehenden Reihenfolge. Der alte Test scheiterte zuvor auch mit dem unveränderten Ausgangscode; die ursprünglichen fehlgeschlagenen Läufe unter `mechanics-test-v2` und `mechanics-baseline-v2` bleiben erhalten.

## Neue tatsächliche Beobachtung

Claim-first belegt bei gehaltenem Gate null Reservation-Checkouts, PID 0 und ein tatsächlich noch unerledigtes Promise. Nach Freigabe erfolgt genau ein Checkout; sämtliche ursprünglichen Snapshot-/Fence-/Releaseprüfungen bleiben bestehen. Reservation-first beobachtet den echten vorverbundenen Owner mit identischem PID und Backendstart, idle ohne Transaktion, XID oder zusätzliche Advisorylocks. Nach Freigabe gelten weiterhin Busy-Ablehnung, unveränderte Epoch null, Cancel und anschließende echte Epoch eins.

Zusätzlich prüft ein unabhängiger Pythonprozess den tatsächlich gehaltenen regulären Lock-Inode mit O_NOFOLLOW, fstat, gebundener Device-/Inode-/Owner-/Modus-/Linkidentität und nicht blockierendem flock. Nur Exit 7 bedeutet belegt, nur Exit 0 frei; Fehler oder Signale sind kein Lockbeleg. Nach Freigabe ist derselbe Inode tatsächlich erwerbbar. Die beiden fachlichen Akteure verwenden weiterhin verschiedene PG-Backends innerhalb eines Node-Prozesses. Ihre Queue kann bereits lokal serialisieren; die OS-Probe beweist den gehaltenen Kernellock, keinen zweiten fachlichen OS-Waiter.

Der Test verwendet nun eigenes privates DATA mit gebundener tatsächlicher Identität. Die Bereinigung entfernt es erst nach Beendigung der vorhandenen Ressourcen. Bei Unsicherheit bleibt es erhalten und der Test schlägt fehl. Beide vorherigen DATA-Umgebungswerte werden exakt restauriert.

## Abnahme und Grenzen

Der tatsächliche gesamte PG-Lauf endet mit Exit 0 nach 2,520 Sekunden; der Controller verlangt zusätzlich die echte Abschlussmeldung und verweigert einen übersprungenen Lauf. Gezieltes TypeScript endet mit Exit 0 nach 18,010 Sekunden, ESLint ohne Warnungen mit Exit 0 nach 1,929 Sekunden. `admission-kernel-v1-terminal.json` bestätigt unveränderte Eingabequellen einschließlich des tatsächlich aus diesem Worktree geladenen Python-Runtimehelpers. Private Originale: `/private/tmp/canvas-native-path-admission-8gusy9ys/`.

Ein unabhängiger rein lesender Review findet keinen Blocker und benennt ausdrücklich die Grenze des Einprozess-Domainnachweises. Der anschließende read-only PG-Postcheck bestätigt null Schemas und Backend-Sessions unter den vorhandenen Admission-Testpräfixen bei nicht zugewiesener XID; das gemeldete eigene DATA und der ursprüngliche Node-Prozess sind abwesend. Originalreport: `admission-kernel-resource-postcheck-v1.json`. Der Test protokolliert keine Schema-OID; daraus wird kein zusätzlicher eigener OID-Nachweis abgeleitet.

Die Korrektur ist kein vollständiger Live-Room-, MCP-, OAuth- oder Browsernachweis. Claim-/P0-/Drain-/Owneranschluss, atomarer Deleteabschluss und Terminalinvalidierung bleiben offen. Der letzte vollständige Browserstand bleibt 8/9; allgemeine Aktivierung, Dateiaktions-Undo und Review Center bleiben aus.
