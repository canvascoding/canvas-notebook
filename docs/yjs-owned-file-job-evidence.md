# Aktuelle Jobrechte auf der tatsächlichen Lifecycle-Ownerverbindung

Stand: 16. Oktober 2026. Enges Produktfundament auf Root `4033ef0131247d8700d220927cc7c8f578cce78d` / QA `9c350ccc701e433d9b17aaf8d5e14dc866206e53`. Dies ergänzt die echte Claim- und Laufzeitbindung; der reguläre Executor, Archive- und automatische Publicwriter sind daran noch nicht angeschlossen. Allgemeine Aktivierung und Review Center bleiben ausgeschaltet.

## Implementierter Vertrag und Grenze

Der neue synchrone Storegetter liest ausschließlich die private, eingefrorene Originalbindung eines aktuell lebenden Claims. Kopien, fremde beziehungsweise geschlossene Belege und bereits abgeschlossene Claims werden abgewiesen; abgefangener Missbrauch vergiftet die aktive Laufzeit. Dieser Vorbereitungssnapshot ist weder eine frische DB-Prüfung noch Actor- oder SQL-Ownerautorität.

Die neue Ownerhülle ist auf genau einen ursprünglichen Direct-/Apply-Delete-Schritt mit gebundenem nichtlegacy Workspace beschränkt. Sie leitet Scope und Pfad aus dem tatsächlichen Claim ab, weist geerbte Lifecycle-Leases und verschachtelte Owner-/Handoff-Einstiege zurück und bereitet Lizenz sowie gehaltene DATA-/Workspace-Verzeichnisse vor der SQL-Phase vor. Directoryidentität bleibt über FD und benannte dev/ino-Bindung erhalten; der eigene Delete darf nicht anhand veränderlicher Directoryzeitstempel als Rootwechsel ausgelegt werden.

Der bestehende Lifecycle-Guard eröffnet das tatsächliche dedizierte B. Die private Hülle bindet dessen Backend/PID/Start, DB-/Schemaherkunft, eigenen exklusiven Admission-Key und exaktes Leaseobjekt. Kurze serielle RC/RW-Phasen prüfen Claim, Transaktionsidentität und aktuelle Jobrechte auf demselben B; zwischen Phasen muss B idle bleiben. Ein äußerer Callback erhält nur einen opaken Owner, ein interner Writer eine überwachte SQL-Fassade. Kein frei konstruierter FileLock, BetterAuth-Principal oder Tool-Invocationbeleg ersetzt diese Herkunft.

Die feste Jobpolicy verwendet die vorhandenen aktuellen Account-, Seat-, Organisations-, Workspace- und Agentprüfungen. Ein gewöhnlicher dauerhafter Userjob benötigt keine erfundene BetterAuth-Session. Ein Agentjob bleibt an die tatsächliche gespeicherte PI-Herkunft und die bestehende Agentzugangspolitik gebunden; unabhängige gültige Mitgliedschaft und Grant bleiben alternative Zugänge. Es werden keine neuen Public- oder Dateirechte verliehen. Der Job speichert die PI-Session-ID; die numerische PI-Zeilen-ID und das Agentprofil werden je kurzer Phase gebunden. Eine vor Jobstart neu angelegte PI-Zeile mit derselben Session-ID ist damit nicht als historischer Austausch nachgewiesen.

Fehler bleiben auch nach Abfangen fatal. Noch laufende SQL-Arbeit wird vor ROLLBACK und Disposal abgewartet; entkommene Phasen können keinen Erfolg bestätigen. Ein verlorenes tatsächliches COMMIT-ACK invalidiert den Owner und seine Lease, verwirft B und meldet den unklaren Ausgang. SQL-Marker oder ein späterer Read sind kein Beleg einer vollständig abgeschlossenen Datei-/Publicoperation und erlauben keinen blinden Replay.

## Tatsächliche Gegenproben und Regressionen

| Prüfung | Ergebnis und Beweisgrenze |
| --- | --- |
| Erster WIP-Lauf, 26-Familien-Quelle `59e2…` | Tatsächlicher Exit 1 nach 25/26: Die Fixture erwartete beim Widerruf eines Grants fälschlich eine Ablehnung trotz unabhängig gültiger Agentmitgliedschaft. Korrigiert wurde die Fixtureerwartung; die bestehende OR-Zugangspolitik des Produkts blieb unverändert. Dieser Lauf bleibt FAIL. |
| Finale Gegenprobe | Auf unveränderter finaler 29-Familien-Testquelle wird ausschließlich die eine notwendige `captured.failure`-Hochstufung bei verlorenem COMMIT-ACK entfernt. Originalsession `53133` endet tatsächlich mit Exit 1 nach elf bestandenen Familien am zwölften Fall. Anschließend werden die exakten finalen Produktbytes wiederhergestellt. |
| Finaler PG18-Lauf | Originalsession `99098`, tatsächlicher Exit 0: 29/29 Familien; `schemaRemoved:true`, `dataRemoved:true`, `openClients:0`, `openCheckouts:0`. Der Completionmarker steht erst nach abgeschlossenen Assertions und Cleanup. Originalprotokoll: `/tmp/canvas-owned-job-pg-final.log`. |
| Inhalt der 29 Familien | Tatsächlicher Guard-Backendbezug und serielle XIDs, User-/Agentherkunft, fehlende erfundene Session, geerbte/falsche/behaltene Owner, abgefangene und entkommene Fehler, Querydrain vor Rollback, verlorenes tatsächliches COMMIT-ACK, Rootinodewechsel, tatsächlicher Leaseablauf, Claimwechsel sowie aktuelle Account-/Seat-/ACL-/PI-/Agentrevokes einschließlich gleicher B-Verbindung. |
| Bestehende Autoritätsfolgen | Die ursprünglichen Member66-, Agent49- und Guest30-Familien bestehen mit tatsächlichem Exit 0. Cachefreies finales TypeScript, Originalsession `78053`, und Scoped-ESLint bestehen ebenfalls mit Exit 0. |

Die Fixture verwendet die tatsächlichen PG18-Queries, Lizenzprüfung und aktuellen Autoritätsquellen. Ihre Mutationsbelege sind ausschließlich SQL-Marker. Sie prüft ausdrücklich unveränderte Originaldateibytes und Dateiidentität; weder Trash/Delete noch Archive, Linkschreiben, Publicrevoke oder ein vollständiger Executoranschluss werden durch diesen Lauf abgenommen.

Eingefrorene Quellen: Test `f290d1dd844b23d8d08b7d1ddef9779398b2408ef7c43b5c09ecb51279613233`; Ownerhülle `694504aeeb70375c1bd65f78ac84549997c7f45b97177823d350f806e89d2d58`. Beide lokalen Quellenhashes wurden frisch geprüft; der Testhash stimmt zusätzlich mit dem Originalprotokoll überein.

GitNexus staged meldet Root 17 Symbole/5 Dateien, MEDIUM/einen Flow; QA 25/5, LOW/keinen Flow. Die weiterhin falschen Zeilenzuordnungen verhindern einen Sicherheitsabschluss allein aus diesen Zahlen. Der tatsächliche AST-Beleg `/tmp/canvas-owned-job-ast.json` zeigt im Store ausschließlich den zusätzlichen Getter, acht geänderte bestehende Deklarationen in `request-principal.ts` und die neuen Jobhelper; weitere Owner-/Fassaden-/Fixturesourcen sind gesondert geprüft.

## Frischer Build und gezielte Browserregression

Der frische Produktionsbuild auf QA `9c350ccc701e433d9b17aaf8d5e14dc866206e53` endet tatsächlich mit Exit 0, Originalsession `44218`. Die folgende unveränderte Browserdatei `tests/public-share-native-owned.spec.ts` besteht mit 2/2 Fällen, Originalsession `88159`: nativer Rich-Inhalt und Bilder im anonymen Link, Download und Widerruf im UI sowie derselbe Ablauf mit einem führenden Leerzeichen im Dateinamen. Kein Skip, Timeout, Abbruch oder Testfehler; 51,3 Sekunden Browserzeit.

Vor-/Nachprüfung sind identisch: Source `ac973c020537eb9e137ba1e3a2fdab52084bf91bca06851168e88dd3999cd8ce`, Build `7608da9cddbdaf93a82394dfe283c152aa6a86ace8a6664315de88afe4cdebf9`. Der Originalsupervisor meldet bestanden und bereinigt. Die zusätzliche ausschließlich lesende Abschlussprüfung bestätigt ursprüngliche Rootidentität, DATA-Abwesenheit, geschlossene Notebook-/Issuerports, entfernte Laufsperre und Abwesenheit beider eigenen Datenbanknamen samt OIDs; der Wartungsclient ist geschlossen.

Das ist die gezielte Regression bestehender Oberflächen nach dem gemeinsamen Policyanschluss. Die Browserfälle rufen den neuen Owner noch nicht als Datei-Executor auf und belegen weder automatische Archive-/Publichooks noch ein Timerinterleaving oder die vollständige Datei-/SDK-/PDF-Abnahme. Die Aktivierungsabweichung bleibt ausschließlich im QA-Worktree; Root aktiviert native Sitzungen weiterhin nicht allgemein.

Private, mit vollständigen Checksummen gesammelte Originalprotokolle und Quellen liegen unter `/private/var/folders/bx/tjzzmjhn2qdcdyfc_l7hkv900000gn/T/canvas-owned-file-job-evidence-GXpHxX/manifest.json` (31 Einträge; Manifest-SHA256 `49ae710ca803206b4da67a48eda5beca67b9537b1293fa7297c1b543fd6450ad`). Die Sammlung enthält keine Runtime-ENV-Dateien, Roh-Recoveryreceipts oder Traces.

## Nächster Anschluss

Nachtrag: Der [geschlossene ursprüngliche Delete-Pfad](./yjs-original-delete-owned-evidence.md) verbindet inzwischen echte Datei-/Native-/Public-/Trashbelege mit diesem Owner. Seine finale 20er PG18-Folge und Gegenprobe sind dort getrennt dokumentiert. Der folgende Absatz beschreibt den damaligen Stand dieses Fundaments; der allgemeine Executoranschluss und Gesamtabschluss bleiben weiterhin offen.

Der nächste Anschluss muss ursprüngliche Datei-/Dokument-/Lineage-/Generations- und Publicziele an den konkreten Jobschritt binden und auf dem bewiesenen Owner-B ausführen. Executor, Archive, atomare Sideeffectreceipts, COMMIT-Recovery und verzögerte Hooks bleiben offen; ein tatsächliches Interleaving mit dem Worker-Verlängerungstimer ist hier nicht geprüft. Ebenso offen sind Lockfamilie, vollständige Datei-/Linkkoordination und Gesamt-E2E. Dieses Fundament aktiviert keinen Core-SDK-Pfad.

Der jüngste Nutzerwunsch nach einem Standard-Skill mit bedarfsweisem Kontext ist bereits in `docs/central-notebook-file-api-import-plan.md` §4.1–4.3 konkret enthalten. Marketplace wurde sauber auf HEAD `54ce6573502f67f4cb6227871000aa315ab87dbe` geprüft. Weder SDK noch `canvas-notebook-documents` sind dadurch ausgeliefert oder abgenommen. Nichts wurde mit diesem Fundament gepusht, veröffentlicht oder allgemein aktiviert.
