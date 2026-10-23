# Ursprüngliches Dokument wiederherstellen: Restore und Jobphasen

Stand: 16. Oktober 2026. Dies beschreibt den engen Original-Delete-/Restore-Kern.
Produktcode: Root `87a77f7d441e0c35fccd14be5f150292b9166011`, QA `bc698ae3595d2e34dac3a300037bbcaebf235078`.
Die lokale PostgreSQL-Matrix, der frische Build und die bestehende Oberflächenregression sind abgeschlossen.
Der allgemeine Datei-Executor ist noch nicht angeschlossen.

## Gebundener ursprünglicher Restore

- [Original-Delete-Service](../app/lib/files/workspace-operation-original-delete.ts): Undo bindet die ursprünglichen Delete-Belege und die Trash-ID; eine neue Datei am alten Pfad wird nicht als ursprüngliches Dokument übernommen.
- [Job-Owner](../app/lib/files/workspace-operation-job-lifecycle-owner.ts) und [Principal](../app/lib/workspaces/request-principal.ts): Der aktuelle menschliche Undo-Akteur benötigt seine heutigen Rechte. Eine beendete PI-Sitzung des ursprünglichen Agenten verhindert diesen menschlichen Undo nicht. Historische Agentrechte erteilen keine heutigen Rechte.
- [FS-Kapsel](../app/lib/filesystem/prepared-single-file-trash.ts): Vor dem Reverse-Rename wird ein neuer, unveränderlicher Undo-Intent dauerhaft gespeichert. Er bindet die ursprüngliche Trash-Quittung samt Payload-/Root-Pins und die jetzt vorgefundenen, vakanten Zielparents.
- Wiederaufnahme verwendet genau diesen gespeicherten Intent. Sie übernimmt keine frisch gefundene D2 und keine nachträglich ausgetauschten Parent-Verzeichnisse.
- Eine ursprünglich fehlende Projektion ist ein logischer FS-No-op ohne erfundenen Inode oder Dateihash. Die native Zielvakanz bleibt eine eigene Prüfung des Services.

## Native und SQL-Abschluss

Die [native DAL](../app/lib/files/workspace-operation-original-delete-native.ts) und der
[Restore-Übergang](../app/lib/collaboration/native-file-archive-transition.ts) prüfen den tatsächlichen
archivierten Zustand. Es gibt keine vorübergehende Umdeklaration als aktives Dokument.
Die ursprünglichen D1-/L1-IDs, Bytes, State-Vector, State-Proof, Dokumentsequenz und Speicherzeit bleiben erhalten.
Aus der ursprünglichen Generation G wird beim Archivieren G+1 und beim Restore G+2.
Registry und Lineage werden passend aktiviert; die abgeleitete Projektion bleibt unbestätigt.

Nach beobachteter FS-Wiederherstellung bindet die zweite Mutationsphase auf derselben echten Owner-Connection B
native Aktivierung, Trash-Status und private Abschlussquittung in einer SQL-Transaktion.
Die [private Speicherung](../app/lib/files/workspace-operation-original-delete-repository.ts) hält Intent und Abschluss gebunden.
Die ursprüngliche Public-Freigabe bleibt widerrufen; Undo belebt weder S1 noch alte Grants oder Locks wieder.

Ein tatsächliches COMMIT mit verlorener Antwort wird über den unveränderlichen historischen Abschluss erkannt.
Dieser Beleg kann nach einem späteren legitimen erneuten Archivieren von D1 weiter gelten.
Er erlaubt weder eine Mutation noch eine Übernahme von D2/S2 am wiederverwendeten Pfad.
Der äußere Room-/Lifecycle-Guard kann auch bei vorhandenem historischen Beleg noch `busy` zurückgeben;
die Quittung umgeht diesen Guard nicht.

## Heartbeat und Owner-B-Phasen

Das [Scheduling](../app/lib/files/workspace-operation-job-phase-scheduling.ts) bindet den tatsächlichen Store-Claim.
Der [Worker](../app/lib/files/workspace-operation-batch-worker.ts) pausiert und drainiert seine Erneuerung,
bevor B seine Jobpolicy-Phase beginnt und die Claimzeile sperrt. Der davor liegende kurze
Lifecycle-Verfügbarkeitsread hält noch keinen Claim-Row-Lock. Erst nach vollständigem COMMIT/ROLLBACK und nötigem Disposal
wird der Claim erneut bestätigt und die regelmäßige Erneuerung fortgesetzt.
Damit schreibt die Heartbeat-Connection A nicht gegen den von B gehaltenen Claim-Row-Lock.
Abgefangene, verschachtelte oder abgetrennte Fehlverwendungen bleiben fatal;
eigene unbestätigte COMMIT-/Disposal-Fehler mit Status 503 bleiben erhalten.

## Tatsächliche lokale Prüfungen

| Prüfung | Ausgang |
| --- | --- |
| Ursprünglicher Delete | Originalsession `73151`, Exit 0, 20/20 tatsächliche PG18-Gruppen. |
| Restore | Originalsession `13775`, Exit 0, 10/10 tatsächliche PG18-Gruppen, einschließlich des ausdrücklich gesperrten V1-Falls. |
| Restore-Recovery | Originalsession `48330`, Exit 0, 5/5 tatsächliche PG18-Gruppen. |
| A/B-Scheduling | Originalsession `5959`, Exit 0, 1/1 tatsächliche PG18-Gruppe mit Delete und Undo. |
| Owner-/Rechte-Regression | Originalsession `57338`, Exit 0, 30/30 tatsächliche PG18-Gruppen. Diese Folge prüft das Ownerfundament mit SQL-Markern. |
| Bereinigung | Alle fünf Läufe bestätigen nach ihren Assertions `schemaRemoved:true`, `dataRemoved:true`, `openClients:0`, `openCheckouts:0` und danach ihren Completionmarker. |
| Statische Prüfung | Vollständiges cachefreies TypeScript, Originalsession `75317`, Exit 0; Scoped-ESLint aller 15 geänderten Quelldateien, Originalsession `42340`, Exit 0. |

Die PG-Fixture trennt vier serielle Gruppen unter dem unveränderten 180-Sekunden-Watchdog.
Delete und Restore liefen mit Quellhash `baa8c5f8d0aaf0953e2285a7a28b37171a10ac82ebbe1e4e6e9c61404484cf5c`.
Danach wurde ausschließlich der Scheduling-Test präzisiert, um den vorgelagerten Lifecycle-Read
von den fünf tatsächlichen Jobpolicy-Transaktionen zu unterscheiden. Die exakte inverse Änderung
ergibt wieder den vorherigen Hash; alle übrigen Testbytes sind unverändert.
Recovery und Scheduling bestehen auf finalem Quellhash `12dfd1d49f85940bcc3606ca8f3c90f646bce8fd2a4b0a1a9ed7fa6925fbc53f`.

Ein früherer zu großer Lauf erreichte den Watchdog ohne eigenen Abschluss; seine eindeutig
identifizierten Ressourcen wurden anschließend separat entfernt und die Abwesenheit geprüft.
Ein erster regulärer Restore-Lauf mit paralleler Typprüfung endete nach vier Gruppen mit einem
verschachtelten Fehler, dessen untergeordneter Code damals nicht protokolliert wurde. Die Ursache
ist damit unbestätigt. Die finale serielle Folge besteht ohne Produkt-Guardänderung; die begrenzte
Fehlerdiagnose enthält jetzt auch untergeordnete Codes und Quellstellen, keine SQL-Argumente oder Tokens.

GitNexus erkennt im veralteten Index sechs bekannte Symbole in Root und vier in QA bei jeweils
15 geänderten Quelldateien. Die neuen Kernfunktionen fehlen dort noch; die leere Prozessliste
ist kein Sicherheitsnachweis. Die konkreten Codepfade wurden zusätzlich unabhängig lesend geprüft.

## Frischer Build und bestehende Oberflächenregression

Der verwaltete Produktionsbuild auf dem genannten QA-Commit endet in Originalsession `18718` mit Exit 0.
Die zusätzliche Vorprüfung `14285` und Nachprüfung `87718` bestätigen denselben vollständigen Beleg:
Source `4ebfde27eac8270057eeba49aad1c31c82afe94cf9baded39879dba859c1fc4e`,
Build `2836e3beecd49ee146eee3cda16afec8ff89d22c4e816a547bdccdad8a8cbab0`.

Die vorhandene Folge `tests/workspace-operation-automatic.spec.ts` besteht in Originalsession `37428`
mit Exit 0, 2/2 Fällen in 45,0 Sekunden, ohne Fehler, Skip, Timeout oder Abbruch. Desktop und Mobilgerät
prüfen tatsächliches Umbenennen, Löschen, Toast-Undo, Inhaltsrückkehr und Inline-/Wiki-/Bild-/Referenzlinks
bei ausgeschaltetem Review Center. Zwei erzeugte Screenshots wurden zusätzlich visuell geprüft.
Die Folge besitzt lediglich den streng gebundenen Anschluss an den vorhandenen versiegelten Yjs-Testsupervisor.
Sie ruft weiterhin den allgemeinen Executor auf und belegt keine UI-Verwendung des neuen Original-Restore-Kerns.

Der abgeschlossene Originalsupervisor meldet entfernte eigene Datenbanken und DATA. Eine separate
nur lesende Prüfung bestätigt Rootidentität, fehlende DATA/tmp und Runlock, geschlossene Notebook-/Issuer-/Controlports,
beendete Parent-/Issuerprozesse sowie die Abwesenheit beider eigenen Datenbanken nach Namen und OIDs.
Ihr Wartungsclient ist geschlossen. Build- und Quellstand sind während der Browserfolge unverändert geblieben.
Eine unabhängige passive Prüfung bestätigt Originalreports, Root-/Dateirechte-/Markerbindung,
abwesende DATA/tmp/Runlock und Prozesse sowie alle drei geschlossenen Ports und bytegleiche Vor-/Nachbelege.
Die PostgreSQL-Abwesenheitsquery wurde von Root tatsächlich ausgeführt; der unabhängige Prüfer hat deren
begrenzten Read-only-Code und Ergebnisbeleg gelesen und keine zweite PG-Verbindung geöffnet.
Root und QA unterscheiden sich weiterhin ausschließlich im bestehenden Aktivierungsgate und zwei historischen Dokumenten;
die 15 neuen Quelldateistände sind bytegleich. Es wurde kein Container gebaut, nichts gepusht und nichts veröffentlicht.

Private Sammlung: `/var/folders/bx/tjzzmjhn2qdcdyfc_l7hkv900000gn/T/canvas-original-restore-evidence-c2c_ng9e/manifest.json`,
46 Einträge, Manifest-SHA256 `432369df76be8af849ed5ae0275fe60767d4b93c2561cba2f967d2cbb50d2231`.
Die Sammlung enthält Quellen, begrenzte Originalprotokolle und Screenshots; keine Runtime-ENV,
privaten Zertifikate, rohen Recoveryreceipts oder Browsertraces.

## Grenzen und weitere Anschlüsse

- Aus vorangegangenen Läufen bestanden: 34 Pure-Übergangsfälle, 38 echte FS-Fälle,
  20 Scheduling-Familien und drei Worker-Fälle. Diese Zahlen ersetzen keine finale integrierte Abnahme.
- Die [PG-Fixture](../scripts/workspace-operation-original-delete-postgres-test.ts) verwendet echte Produktionslizenzprüfung,
  aktuelle Rechte, Storeclaims, dedizierte B-Verbindungen und tatsächliches Dateisystem. Public-Create-Rows sind explizite Testdaten,
  kein Beleg für eine ursprüngliche HTTP-/Toolanfrage oder die Public-Create-Autorisierung.
- Abgedeckte Kernelmechanik umfasst ursprüngliche physische Payloads, Plain/XML/Blocks,
  gültiges nicht verlustfrei exportierbares Rich mit vorhandener Projektion sowie fehlende Projektionen.
  Daraus folgt kein allgemeiner Dateiaktions- oder UI-E2E-Erfolg.
- Bekannte V1-Grenze: Bei nicht exportierbarem native-only Markdown scheitert die bisherige
  Hash-/Planvorbedingung vor Intent und Mutation. Das ist ein expliziter gesperrter Fall, kein erfolgreiches Restore-Szenario.
- Allgemeiner Batch-Executor und Undo-Verfügbarkeit sind noch nicht angeschlossen.
- Zielparents müssen bereits existieren; diese FS-Kapsel legt sie nicht an. `EXDEV` bricht ohne Copy/Remove-Fallback ab.
- Portables Node-`rename` besitzt hier kein atomisches `NOREPLACE`. Frische Vakanzprüfungen setzen den echten
  exklusiven Owner-/kooperativen Writer-Fence voraus; sie garantieren keinen Schutz gegen unkooperative Host-Dateisystemeingriffe.
- Der frische Build und die gezielte bestehende UI-Regression ersetzen keinen allgemeinen Aktivierungs- oder Veröffentlichungsbeleg.
