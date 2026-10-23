# Einzelner Markdown-Chunkimport: I-05

Stand: 15. Oktober 2026. **Sourceanschluss und unabhängige Integrationsprüfung abgeschlossen; Produktgate und gemeinsame Browserabnahme bleiben offen.**

Autorencommit: `d415bf599e7d4db5dde915e9db9d61fff7d91dfd`, Basis `e98c95770379eb089dcf579f4fd01b7872b3f13c`. Die 21 Dateien wurden unverändert in den Integrationsworktree übernommen. Root hat jede Datei gegen eingefrorene Bytes und Commit geprüft. Von den weiteren 6.544 Dateien unterscheiden sich nur die beiden zuvor bewusst fortgeschriebenen Plandokumente; diese entsprechen exakt dem eigenen Docs-Commit `a37b7a5b6ce822a7d3745ad356e36b774acfd377`.

## Enger Produktvertrag

- Nur eine im ursprünglichen Uploadmanifest einzelne neue `.md`/`.markdown` tritt in den nativen Pfad ein; Web und Mobile verwenden `createOnly`. Die tatsächlichen vollständigen Quellbytes sind vor nativer Mutation auf 5 MiB begrenzt. MIME allein erteilt keine Freigabe.
- Der ursprüngliche tatsächliche Request wird erneut authentisiert. Request-/Operationsidentität stammt aus den serverseitigen Upload-/Datei-IDs. Der private Dispatch läuft vor dem generischen Revision-/Rohwriterweg; ein Importfehler führt nicht zum Rohwriter zurück.
- Die tatsächlich gehaltene Session-SH-/File-EX-Lifetime kann genau eine aktuelle Source ausleihen. Rekursive oder konkurrierende Sourceaufnahme wird früh abgewiesen; historische Bytes oder öffentliche Locators bilden keinen Source-Grant.
- Native Persistenz, erste Veröffentlichung und der vollständige erste Source-/Session-/File-Schließvorgang enden vor den Routefolgen. Unter einer neuen echten Transport-/Workspace-Fence werden ursprünglicher Request, eigener Ledger und aktuelles Ziel erneut geprüft; danach laufen bestehende Share-/Publish-/Cache-/Auditfolgen. Erst nach einer weiteren Prüfung folgen `completed`-Progress und Source-Cleanup.
- Bestätigte Wiederholungen und `completed`-GET prüfen die eigene historische Quittung sowie aktuelle native und physische Identität, ohne den alten Sourcezugang zu erneuern. Geschlossene Deskriptoren, exakte Elterngrenzen und eigenes ursprüngliches Ziel bleiben Teil des Belegs.
- Web liefert bei Pending `202` mit expliziter Completion und ohne `committed`. Die vorhandenen Native-Mobile-Clients erhalten `409` statt einer scheinbar erfolgreichen Dateiantwort. Die echte ursprüngliche Native-Queue behält dadurch ihren persistierten Versuch und ihre lokale Quelle; ein späterer Completed-GET wird vor deren Entfernung erneut geprüft.
- Höchstens 16 öffentliche Wiederaufnahme-Locators pro Konto werden über die vorhandenen Authscope-/Resetgrenzen gespeichert. Hydration startet keinen Request. Wiederaufnahme verwendet ausdrücklich dieselben IDs und den serverbestätigten Zielpfad.

Das vorhandene zentrale Gate bleibt unverändert mit Produktkonstante `false`. Sein bereits vorhandener, ausschließlich an `NODE_ENV=test` gebundener Testeingang erlaubt der isolierten Fixture die ausdrücklich geprüften Gatezustände. Es gibt keinen privaten Gatehook und keinen neuen Produktionsschalter. Bei deaktiviertem Gate bleiben Erstversuch und Quelle als `unavailable` erhalten; es entsteht weder natives Dokument noch Rohdateiersatz.

## Geschlossene Reviewbefunde

Die unabhängigen Prüfungen schlossen drei konkrete Lücken:

1. Ein Schließfehler nach nativer Veröffentlichung durfte keinen Transportabschluss vor noch ausstehenden Routefolgen hinterlassen. Die beschriebene Reihenfolge verhindert deren dauerhaftes Überspringen.
2. Ein Fehler des zweiten Observers nach bereits gelaufenen Routefolgen durfte keine Pending-Antwort zusammen mit `committed` erzeugen. Der Webmapper lässt dieses Feld bei Pending weg; der strenge Clientparser bleibt unverändert.
3. Home braucht auch nach Dialogschluss/Reload einen Wiederaufnahmeeinstieg und nach bestätigtem Resume eine frische Dateiliste. Der dauerhaft gebundene Progress und ein enger privater Completionhinweis erreichen Home auch beim Resume über den anderen Dialogbutton. Pending, Fehler und überholte Auth-/Workspaceantworten lösen diese Aktualisierung nicht aus; Listener werden entfernt.

Der ursprüngliche generische Complete-Zweig und 110 bestehende Funktionskörper sind bei Root zusätzlich tatsächlich gegen die Basis verglichen. Allgemeine Guard-/Principal-/Broker-/SQL-/Python-/FD-Verträge, Office-/DOCX-Körper, `UploadDialog`, breiter Uploadclient, Pakete und Lockfiles bleiben erhalten.

## Unabhängige Rootprüfungen

| Prüfung auf dem integrierten Stand | Ergebnis |
| --- | --- |
| Vollständige echte exportierte Route-/Auth-/PostgreSQL18-/FS-Matrix | **17 Familien, Exit 0** |
| Vollständiges TypeScript, cachefrei, 12 GiB | Exit 0 |
| ESLint aller 19 geänderten/neuen TS-/TSX-Dateien | Exit 0 |
| Echter Client-/Store-/React-Consumer einschließlich Home-Wiederaufnahme | Exit 0 |
| Zusätzliche Source-Lifetime-Fälle mit tatsächlichem Dateisystem/Helper | 8 Familien, Exit 0 |
| Vorhandene Upload-Lifetime-Regression | 22 Familien, Exit 0 |
| Bestehende Upload-UI-, Home- und Uploadjob-Suiten | jeweils Exit 0 |

Die volle Routenmatrix prüft unter anderem erste echte Cookie-Web-/Bearer-Mobile-Abschlüsse ohne Happy-Path-Retry, Byteprofile und Plain-Fallback, Größenlimit vor Mutation, fremdes Ziel, Rechteentzug, tatsächlich getöteten Vorbereitungshelper, Progress-Rename-Fehler, echte Source-/Transport-/Observer-Schließfehler, veränderte aktuelle Ziele, ursprünglichen Native-Queueverbraucher und Gatefalse-Completed-Beobachtung. Auth, native Services, Ledger und SQL wurden dabei nicht durch Attrappen ersetzt; nicht verfügbare Expo-Dateisystem-/Platformgrenzen des Original-Mobileconsumers sind ersetzt. Das ist kein App-/Browser-/Gerätenachweis.

Nach dem vollen Lauf hat Root die Abwesenheit des Nodeprozesses, aller 2.654 bekannten Helperprozesse, der eigenen DATA und aller 154 beobachteten Laufzeitbackends unabhängig geprüft. Der Test selbst wartet vor seinem Abschluss endlich und rein lesend auf die tatsächliche Serverabwesenheit und prüft Entfernung seines UUID-Schemas. Niemand beendet Backends, um Cleanup erfolgreich erscheinen zu lassen.

Die älteren Autorenläufe bleiben ehrlich getrennt: 14 Familienkörper mit Prozess-Exit 1 wegen fehlendem `archived_at` in der eigenen Fixture; anschließend drei gezielte Familienkörper mit Prozess-Exit 1 wegen einer noch sichtbaren, später unabhängig als geschlossen bestätigten Verbindung. Diese Läufe wurden nicht nachträglich als erfolgreich umetikettiert. Die neue Root-Vollmatrix prüft die korrigierte Fixture und Serverabschlussbarriere zusammen. Die frühere tatsächliche `25P04`-Ursache ist damit nicht rückwirkend bewiesen.

## Grenzen und nächste Schritte

Historische generisch abgeschlossene Markdownuploads ohne eigenen nativen Ledger werden nicht übernommen. Ein späterer legitimer Peer-Projektionswechsel kann die strenge ursprüngliche physische Zielprüfung konservativ als `recovery_required` enden lassen. Native Daten und Quellartefakte bleiben erhalten. Die aktuelle Lineage-Gegenprobe des Nativeconsumers simuliert einen gültig gespeicherten Identitätskonflikt; sie ist kein vollständiger Archive-/Restore-Lifecyclelauf.

Routefolgen können nach erfolgreicher Wirkung vor Progressbestätigung oder bei konkurrierenden Versuchen wiederholt werden. Es gibt keine neue Exactly-once-Garantie; das bestehende Best-effort-Verhalten des Auditdienstes bleibt erhalten. Die direkte Office-Sourceprüfung des Autors scheiterte an fehlender Datenbankkonfiguration und zählt nicht als bestandene Officeabnahme.

I-06 schließt den manuellen Create-Einstieg an. Danach prüft I-07 den frischen gemeinsamen Build mit tatsächlichem UI-Create, erstem Clipboard-Paste, bewusster Markdown-Insertion, Dateimport, Home-Resume, Desktop/mobilem Web und beiden Hostneustarts. Der frühere [kompilierte Mobile-Protokolllauf](./yjs-native-compiled-protocol-evidence.md) auf der älteren Basis ersetzt diese Abnahme nicht. Weitere Importflächen und initialisierte/aktive Ziele folgen den getrennten Gates des [Anschlussplans](./markdown-create-paste-full-import-integration-plan.md).

Private Belege: `/var/folders/bx/tjzzmjhn2qdcdyfc_l7hkv900000gn/T/canvas-i05-root-integration-b89_du6e/`; Autorenfreeze: `/var/folders/bx/tjzzmjhn2qdcdyfc_l7hkv900000gn/T/canvas-i05-chunk-1c5_0t3l/freeze-manifest.json`, SHA-256 `97b13e4aae1ce75133a9cb32a051e6f66393c5907f64998e8964cb6cbc208be6`.
