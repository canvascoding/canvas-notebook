# Gehaltenen Dateiaktions-Claim mit zwei SQL-Statements prüfen

Stand: 19. Oktober 2026. Dieser abgeschlossene Schnitt optimiert ausschließlich die Prüfung eines bereits tatsächlich gehaltenen Claims. Er aktiviert keine Dateiaktion und beseitigt für sich nicht den noch offenen Delete-/Live-Editor-Zeitlimitfehler.

## Änderung und Grenzen

Die erste Abfrage liest die tatsächliche zugewiesene XID, Isolation, Schreibmodus, vollständige Quellenidentität sowie beide Tabellenauflösungen gemeinsam. Die zweite unabhängige Abfrage hält weiterhin die ursprüngliche Claimzeile mit sämtlichen bisherigen Prädikaten, tatsächlicher Leasezeit und `FOR SHARE NOWAIT`; sie liest danach dieselbe gehaltene XID und die aktuelle Serverzeit. Ohne tatsächlich gehaltene Transaktion stimmen die XIDs nicht überein. Alle bisherigen privaten Lebensdauerprüfungen bleiben bestehen. Es werden keine Claims erzeugt, Rechte zwischengespeichert oder Transaktions-/Leasegrenzen verlängert.

Der gemeinsame Zeilenparser ist mechanisch aus `readClaimSource` ausgegliedert. Roots unabhängiger AST-Vergleich bestätigt identische Parserstatements, unverändertes ursprüngliches Quellen-SQL und unverändertes `assertClaimSource`. Vorher-SHA-256: `6b4197e71417bc38d36646b3ca4b928eeda65b0e4b2e34c3ff30906d774fb7eb`; nachher: `28e230c5d3e2029174b1324a758065c618d0e31ad6e5805d12d6bcf4b33fddfe`.

Die Vorabanalyse bewertet den ausgegliederten Quellenleser HIGH mit drei direkten Aufrufern und vier betroffenen Abläufen. Die Warnung und Prüfung seiner Aufrufer erfolgten vor der Autorenschaft; der neue private Parser ist im Index noch unbekannt.

## Tatsächliche Nachweise

Private Originale liegen unter `/private/tmp/canvas-native-path-admission-8gusy9ys/`. Die Controller protokollieren ursprüngliche Exits, Signale und unveränderte Vor-/Nach-Quellhashes.

| Original | Tatsächliches Ergebnis |
| --- | --- |
| `claim-real-pg-owner-validation-v14.log` | PostgreSQL 18, 34/34 echte SQL-Familien; Exit 0. Einschließlich Autocommit-Abweisung, Quellen-/Token-/Status-/Plan-/Autorisierungsdrift, abgelaufener Lease, Übernahme, Retained-/Detached- und Workerfällen. |
| `direct-worker-real-pg-owner-validation-v14.log` | PostgreSQL 18, ursprüngliche Apply-/Progress-/Recovery- und 20 gespeicherte Undo-Off-Gates; Exit 0. |
| `owned-job-pg-owner-validation-v13.log` | 30/30 tatsächliche Owner-/Principalgruppen; Exit 0, alle eigenen Clients/Checkouts geschlossen. |
| `owner-validation-v15-progress.json` | Gezieltes TypeScript und ESLint jeweils ursprünglicher Exit 0 auf identischem Claim-Quellhash. Die gesamte nachfolgende Live-Folge ist davon getrennt. |
| `claim-check-batching-candidate/root-ast-parity.json` | Alle drei mechanischen Paritätsprüfungen wahr. |

Die unter v13 zunächst als `claim-pg`, `worker-pg` und `direct-worker-pg` bezeichneten Programme verwendeten tatsächlich PGlite. Ihre grünen Ergebnisse werden nicht als PostgreSQL-Nachweis ausgegeben. V14 wiederholt Claim und direkten Worker mit der vorhandenen echten PG-Fixtureauswahl ausdrücklich auf PostgreSQL 18. Beide Originale bestätigen entferntes eigenes Schema, null offene Clients und entferntes Runnerbundle.

Die vollständige Move-/Delete-/Live-Room-Folge, Terminalbenachrichtigung, Editor-Rejoin und der neue gemeinsame Browser-/SDK-Nachweis bleiben im [Owner-Todo](./yjs-native-path-owner-integration-evidence.md) offen. Dateiaktions-Undo, Review Center und allgemeine Aktivierung bleiben ausgeschaltet.
