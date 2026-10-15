# Guest: ursprüngliche Dokumentbindung und Schreibberechtigung

Stand: 15. Oktober 2026. Ausgangspunkt `6cac42e1873d873f1ef311cd7f362a02e51b0c56` im Worktree `824c`.

## Umfang und verbleibender Anschluss

Diese Änderung ergänzt die Daten- und Berechtigungsgrundlagen für die vollständige Guest-Writer-Familie. Die regulären Service-/Routerpfade sind noch nicht insgesamt umgestellt. Insbesondere Create/Manage/Challenge/Verify und das Fehlercleanup nach dem Mailversand dürfen erst nach ihrem tatsächlichen Anschluss als geschützt gelten. Der bestehende [enge atomare Redemptionnachweis](./yjs-guest-redemption-atomicity-evidence.md) bleibt ein eigener Befund. Das globale `executionReady` bleibt falsch.

Die ursprüngliche Move/Delete-Blockade in Produktion ist dadurch nicht behoben. Public-/Lockwriter, reguläre native Dateiaktionen, SDK, Standard-Skill und PDF-Import behalten ihre vollständigen offenen Abnahmen. Review Center bleibt ausgeschaltet.

## Persistierte Einladung und historische Belege

- Neue nullable Spalten `lineage_id` und `lifecycle_generation` speichern die ursprüngliche native Dokumentbindung. Der Check erlaubt ausschließlich ein vollständiges gültiges Paar oder zweimal NULL. Es gibt weder Default noch Backfill und keine automatische Bindung historischer Einladungen an das heutige Dokument.
- Die explizite additive Startmigration läuft vor der Installation der Sideeffect-SQL-Funktionen. Die spätere allgemeine Spaltenergänzung wäre dafür zu spät.
- Für eine ungebundene alte Zeile bleiben die bisherige V1-JSON-Darstellung und der private `preservedRowProof` exakt erhalten. Die neuen NULL-Spalten fließen nicht heimlich in deren alten Digest ein. Eine gebundene Zeile ergänzt `guestBinding: {version: 1, lineageId, lifecycleGeneration}`; die bestehenden vollständigen Stage-/Receipt-Digests decken diese Bindung ab. Historische gespeicherte Bytes werden nicht umgeschrieben.
- Eine Lifecycleaktion darf eine alte Einladung derselben Lineage mit einer früheren Generation endgültig widerrufen. Fremde Lineage/Dokument-ID und zukünftige Generation bleiben ungültig. Ein solcher Widerruf schafft keine neue Gastberechtigung. Die exakte Spaltenprüfung weist weiterhin unbekannte neue Felder zurück.

Die Originalquellen unter `scripts/fixtures/file-guest-target-v1/` stammen aus dem genannten Commit. Herkunft und SHA-256 werden geprüft; nur die dokumentierten relativen Imports sind angepasst. Der Restore-Test erzeugt den historischen Receipt tatsächlich mit diesem alten Code, bevor die neue Migration ausgeführt wird. Erst anschließend lesen und verwenden der aktuelle Reader und Restore denselben unveränderten Beleg. Ein mit neuem Code erzeugter vermeintlicher Altbeleg wäre kein Ersatz.

## Echte Berechtigung und gemeinsame Connection

`withFileGuestInvitationAuthority` ist eine eigene opaque Berechtigung. Sie stammt aus der tatsächlichen Einladung und dem echten aktuellen Einladenden, dessen signierter Team-Lizenz, Sitz und Workspace-Rechten. Sie übernimmt keine vom Aufrufer gelieferte App-Identität oder Session. Alte fehlende Bindungen werden nicht rekonstruiert. Die Zwecke sind Challenge, Redemption und fehlgeschlagenes Challenge-Cleanup.

Die OnConnection-Phase schützt aktuelle Rechte und deren Prädikate auf derselben tatsächlichen Transaktion. Sie bindet zusätzlich die Einladungsrelation, vergleicht Dokument/Lineage/Generation/Policy/Einladenden/Ablauf und erhält die bisherigen Member-Prüfungen. Veränderliche OTP-Felder gehören nicht zur festen Identität. Zeitbudget, Connection-/Schema-/Transaktionsidentität und Callback-Lebensdauer bleiben begrenzt.

Der interne `withFileGuestInvitationWriter` führt genau eine RC/RW-Transaktion aus: echte Authority, frische native Zielauflösung, vorhandene Workspace-Shared-Fence, eine MutationBoundary, Pfadsperre, Einladungszeilensperre, enge SQL-Arbeit und abschließende Prüfungen. Die Einladung wird erst nach Shared-Admission gesperrt. E-Mail, Poolzugriffe, neue Content-Sessions und Dateiarbeit gehören nicht in den Callback. Aktive native Räume bleiben erlaubt. Erst bestätigter COMMIT darf einen erfolgreichen Rückgabewert veröffentlichen; ein unklarer COMMIT oder Releasefehler führt zu benanntem 503 ohne Replay.

`revokeFileGuestInvitation` bildet eine getrennte, ausschließlich monotone Member-Operation: tatsächlicher Request-Principal, aktuelle Freigaberechte und Creator-/Managerprüfung, derselbe Shared-Key, echte historische Pfad- und Dokumentreservation, Policy-CAS und ausschließlich `revoked` plus Challenge-Löschung. Er benötigt kein weiterhin vorhandenes aktuelles Nativeziel. So bleiben NULL-gebundene, verschobene, veraltete oder entfernte Einladungen widerrufbar. Er kann nichts erneuern, zurückbinden oder eine Session anlegen. Die zusätzliche Einladungs-/Admissionrelation ist auch unter Member-Principal explizit gegen TEMP-Shadows gebunden.

## Physischer Einstieg und UI-Transport

Der bestehende `persistPristineOriginalWorkspaceFileForWrite` akzeptiert optional eine tatsächliche Info-`fileVersion`. Wenn angegeben, wird sie exakt mit der beobachteten Dateidentität verglichen und in den Importfingerprint aufgenommen. Der vorhandene FD-Reader bestätigt weiterhin dieselbe Datei vor und nach dem Lesen. Ohne dieses optionale Feld bleiben bisheriger Ablauf und Fingerprint unverändert. Eine konkurrierend initialisierte native Datei wird nicht als vermeintlich dieselbe physische Quelle übernommen.

Der vorbereitete Freigabedialog teilt einen echten scoped Info-Abruf mit dem Guestpanel. Create transportiert dessen exaktes `expectedTarget`; Manage bleibt bei ID und PolicyRevision. Native Namen werden anhand der registrierten Identität erkannt, auch bei Randspaces oder verändertem Suffix; physische Markdown-Dateien bleiben unterstützt. Fehler, Pfad-/Workspacewechsel und Schließen verwerfen die Zielreferenz. Diese Transportvorbereitung allein ersetzt weder den serverseitigen Zielvergleich noch den tatsächlichen Browser-/Serviceanschluss.

## Native Baseline im vorhandenen Backupspeicher

`captureNativeWorkspaceOperationBackup` übernimmt einen tatsächlichen Request und eine exakte native Info-Zielreferenz. Der Kernel wird vor Principal-/PG-Arbeit erworben. Auf B bestätigen echter Member-Principal und Shared-Fence den aktuellen Scope; aus genau einer persistierten Statezeile stammen Originalbytes, Vektor und Sequenz. Aktive Räume bleiben erlaubt. Ein späterer Live- oder Persistenzstand etikettiert die ältere Baseline nicht um. B ist geschlossen, bevor die private Dateiveröffentlichung beginnt; der Kernel bleibt bis zu deren Abschluss gehalten.

Der neue Einstieg und das bisherige exklusive Capture teilen denselben vorhandenen V2-Publisher, `native.bin`, Manifest, Prüfsummen, Fsync, atomare Veröffentlichung, Aufbewahrung und Recovery. Ein nativer Einzelrecord wird als `native_document` gespeichert; eine physische Markdown-Datei wird dafür weder gelesen noch erfunden. Die API nimmt keinen vom Aufrufer autorisierten WorkspaceContext oder serialisierten Dokumentzustand an. Ein bereits vorhandener gleichnamiger Operationsbeleg muss exakt zu Dokument/Lineage/Generation/Repräsentation/Schema und Scope passen; sein ursprünglicher Hash und seine ursprüngliche Sequenz bleiben unverändert.

Bei nativen Einzelrecords bewahrt auch Restore exakte kanonische Namen einschließlich äußerer Spaces und anderer Suffixe. Der enge Zweig prüft tatsächliche Root-/Parent-/Leafnamen und verbietet Symlinks, Case-Aliase sowie bestehende physische oder native Ziele. Der vorhandene physische Restore behält seine bisherigen Resolver und Guards. Restore erzeugt die regulären frischen Kopieidentitäten; der private Originalbeleg wird nicht verändert.

Die parallele Prüfung fand einen vorhandenen Haltbarkeitsfehler, den der neue Pfad übernommen hätte: Nach erfolgreichem Rename, aber fehlgeschlagenem Scope-Verzeichnis-Sync konnte ein Retry den vorhandenen Ordner zu früh bestätigen. Nun holen alle drei Existing-Erfolgszweige diesen Sync nach. Die echte FS-Gegenprobe lässt zwei Scope-Sync-Versuche scheitern, obwohl Rename bereits erfolgt ist; beide Aufrufe bleiben Fehler. Erst der dritte tatsächliche erfolgreiche Sync bestätigt die ursprünglichen Manifest-/Payloadbytes mit Sequenz 7, während der aktuelle native Stand bereits Sequenz 8 besitzt.

## Bisher ausgeführte Prüfungen

| Prüfung | Tatsächlicher Befund |
| --- | --- |
| `file-guest-target-migration-test.ts` | Exit 0 mit Abschlussmarker: echte frische/alte DDL, Nullbeibehaltung, Pair-Check, wiederholte Migration, unveränderte historische JSON-/Proofbytes, explizite neue Bindung und Originalquellen-Provenienz. |
| `native-file-operation-restore-postgres-test.ts` | Exit 0 und finaler PASS auf echtem PG18. Einschließlich vor ALTER tatsächlich erzeugtem Original-V1-Receipt, unveränderten gespeicherten Bytes und anschließendem aktuellen Restore ohne Guest-Reaktivierung. |
| Authority-/Writer-PG v4 | Exit 0 und Abschlussmarker für 30 echte PG18-Familien. Signierte echte Team-Runtime, aktuelle Rechte/Sitz/Scope, getrennte opaque Berechtigungen, SQL-/Schema-/Lebensdauergrenzen; bestätigter Writer-COMMIT, echter Constraintrollback, tatsächliche Reservationen, aktiver Roomowner, aktuelle und historische monotone Revokes sowie echte TEMP-Shadows. Je drei reale COMMIT-/ACK-/Release-Unklarheitsfälle für InvitationWriter und Revoke belegen genau eine Mutation und Disposal, keinen Erfolg/Replay, den tatsächlichen committeten SQL-Stand und unveränderte vollständige Nativezeilen. Kein Pool-/SQL-Ergebnisersatz. |
| Sideeffect-PG v2 | Exit 0, finaler PASS und ausdrücklicher `COMPLETED`-Marker nach abgeschlossenem Cleanup. Ursprüngliche Assertions und Produktguards bleiben erhalten; neue aktuelle/historische Bindungen, fremde/zukünftige Bindungen, tatsächliche SQL-Stage-Gegenfälle und nachträgliche Manipulationen sind geprüft. Das globale Writer-Phantom-Gate bleibt offen. |
| Original-Bootstrap PG v2 | Exit 0 und Abschlussmarker für 14 echte Auth-/PG18-/Dateisystemfamilien. Tatsächliche Info-Antwort, alter Dateistand, ursprüngliche FD-Identität, source-race ohne Birth, aktuelle Schreibrechte, same-B-Beleg und vorhandene COMMIT-Recovery. Kein Router aktiviert. |
| Guest-Info-Transport | Sechs DOM-/Transportfälle tatsächlich gestartet und bestanden, Exit 0, keine Skips. Produktkomponenten und scoped Requester; Netzwerk und Präsentationsblätter sind Testgrenzen. Kein Browsernachweis daraus. |
| Member-/Metadata-PG v2 | Neuer vollständiger Exit 0 und Abschlussmarker für 60 Familien. Vier tatsächliche Partial-Patch-Konkurrenzfälle bestehen; bestehende Produktguards, Wartebedingungen, Assertions und Timeouts blieben unverändert. Der zusätzliche Observer protokolliert ausschließlich tatsächliche Queryfehler. Dieser Lauf enthält keinen `55P03`-Witness. |
| Native-only Backup-PG v2 | Exit 0 und finaler PASS für zehn echte Auth-/PG18-/FS-Familien einschließlich vollständigem Cleanup. Native Plain/XML/Blocks, fehlende/veraltete Markdown-Ausgabe und nicht verlustfrei exportierbares Rich-Dokument, tatsächlicher Roomowner und späterer Peerstand, exakte Namen und regulärer nativer Restore, reale Ziel-/Alias-/Symlinkkollisionen, aktuelle Rechte/Schema/Binary, echte exklusive Admission, Kernel bis nach B-close/Publikation sowie fehlgeschlagener und nachgeholter Scope-Sync. |
| Bisheriges Native-Backup/Copy-PG | Tatsächlich mit verwalteter lokaler PG18-Verbindung ausgeführt, kein Skip. Exit 0 und vollständiger finaler OK-Marker für bestehende Capture-/Cross-Workspace-Copy-/Restore-, Integritäts-, Publikations-, Konkurrenz- und Idempotenzfälle. |
| Physische Backup-/Agent-Kompatibilität | Die ersten vier Skripte des bestehenden `test:files:operation-backup` liefern ihre jeweiligen tatsächlichen Abschlussmarker. Der fünfte Agenten-Pfadtest hatte einen veralteten PGlite-Connect-Mock und zunächst keinen Abschlussmarker. Nach dessen enger Callback-/EventEmitter-Korrektur läuft das ursprüngliche fünfte Skript unverändert bis einschließlich Cleanup und `: ok`, Exit 0; es beweist weiterhin null optionale Review-Einreichungen. Die fünf Nachweise stammen aus dem Gruppenlauf und dem getrennten abschließenden fünften Lauf, nicht aus einem behaupteten neuen gesamten NPM-Gruppenlauf. |
| Vollständiges TypeScript und Scoped-Lint | Abschließender cachefreier TypeScript-Lauf mit 16-GiB-Heap: Exit 0, kein Diagnoseoutput. Scoped-Lint aller 21 veränderten Produkt-/Testdateien: Exit 0 ohne Warnungen. Die unveränderten eingefrorenen historischen Sourcekopien sind durch Provenienz und TypeScript erfasst. |

Erhaltene Fehl-/Diagnoseläufe werden nicht nachträglich umgedeutet:

- Erster Authority-Lauf: Exit 1, Testzertifikat ohne notwendige echte Team-Runtime-Capability. Nur dessen signierte Fixture-Claims wurden korrigiert; die Produktprüfung bleibt erhalten. Die späteren erfolgreichen Läufe sind neue Läufe.
- Erster FD-Race-Lauf: Exit 1. Der Test überwachte auf macOS den `/var`-Alias statt des tatsächlich geöffneten `/private/var`-Pfads. Nur der Hookpfad und die Fehlerdiagnose wurden korrigiert; reale Dateimutation, strikte Rejectcodes und Kein-Birth-Assertions bleiben bestehen. Der neue vollständige Lauf besteht.
- Erster Sideeffect-Lauf: tatsächlicher Exit 0, aber kein Abschlussmarker. Dies ist ausdrücklich **kein PASS**. Ein begrenzter referenzierter Wächter, Phasenlogs und ein Abschluss-/Exitcheck wurden ergänzt; Produktguards und Assertions bleiben erhalten. Der neue vollständige Lauf besteht einschließlich Ressourcenabschluss. Der ursprüngliche vorzeitige Abbruch ist nicht rückwirkend lokalisiert oder bestanden.
- Erster aktueller vollständiger Member-/Metadata-Lauf: Exit 1 mit `PRINCIPAL_BUSY` im erzwungenen Concurrent-Partial-Patch-Fall. Der Quellvergleich zeigt keine neue Member-Locksemantik; das bestehende 50-ms-Locktimeout kann während des absichtlichen Pfadlockwartens greifen. Der genaue fehlgeschlagene SQL-Schritt dieses alten Laufs ist nicht gemessen. Nur die Diagnose wurde ergänzt, ohne Retry oder Guard-/Timeoutänderung. Der neue gesamte Lauf mit 60 Familien besteht; das ist keine nachträgliche Ursachenmessung des alten Fehlers und keine behauptete produktive Timeoutkorrektur.
- Erster vollständiger TypeScript-Aufruf: Exit 134 am standardmäßigen 4-GiB-Heaplimit. Dieser Lauf ist weder ein TypeScript-PASS noch ein belegter Typfehler.
- Zweiter TypeScript-Lauf mit 16-GiB-Heap: Exit 2 wegen fünf Typfehlern ausschließlich in neuen Testquellen. Diese wurden durch echte Scopeassertion und lokale Typannotationen korrigiert. Erst der dritte gesamte Lauf bestätigt Exit 0. Ein erster Scoped-Lintfehler im UI-Cache wurde ohne Suppression durch unveränderliche Cacheeinträge behoben; die sechs Transportfälle und Scoped-Lint wurden danach erneut vollständig ausgeführt und bestanden.

Die native Baseline ist lokal auf der neuen internen Strecke geprüft; ihr Guest-Create-Anschluss bleibt offen. Der vollständige reguläre Serviceanschluss und dessen neue Browser-/End-to-End-Abnahme stehen noch aus. Keine Veröffentlichung oder Produktionsmutation wurde durchgeführt.

## Frischer Build und bestehender Gast-Browserablauf

Alle fünf Produkt-/Testschritte sind auf Root `55cf40e6a` gesichert und in QA `8cac894e5d4397c9fb4f91cd1bef424b569f72ef` integriert. Die Produkt-/Testsourcedifferenz zwischen diesen beiden Ständen ist ausschließlich das private QA-Aktivierungsflag; drei ältere Plan-/Belegdateien unterscheiden sich zusätzlich. Control Plane blieb sauber auf `27c8ce37da082244f006ca376068cde6b98845d5`.

Der unveränderte Originalbuilder erzeugte einen neuen Produktionsbuild und bestätigte tatsächlichen Exit 0. Unabhängige `assertBuildProof`-Aufrufe vor und nach dem Browserlauf bestätigen denselben QA-Commit sowie dieselben tatsächlichen Source-/Buildfingerprints:

| Bindung | SHA-256 |
| --- | --- |
| Source | `d02e480819af6c7a43ce057c431e1f3894d74d440af60f7feb7906db8ddc08ed` |
| Build | `4377234d3abaa9854d8644cadb0b08ea9f5e89ffcb8ca18e61df32ec3e863ad2` |

Der unveränderte Originalsupervisor führte `tests/editor-guest-collaboration.spec.ts` mit tatsächlichem Exit 0 aus. Sein gesonderter Browserabschluss bestätigt einen deklarierten und bestandenen Fall, null Fehler, Skips, Timeouts oder Unterbrechungen. Der Fall prüft atomaren Login, gemeinsame Bearbeitung, Markdown-Einfügen, Read-only-Rechte und Widerruf eines bereits geöffneten Schreibeditors. Vor den Dateiaktionen ist Review Center ausdrücklich ausgeschaltet. Ein SMTP-Versand ist dabei durch den vorhandenen Challenge-Driver ersetzt; Verify und Gastcookie laufen über den tatsächlichen HTTP-Service.

Dies ist ein Kompatibilitätsnachweis des bestehenden Gastablaufs. Die neue interne Writer-Familie ist noch nicht regulär angeschlossen; ihre komplette API-/Browserabnahme und die tatsächliche neue Dialog-Transportabnahme folgen mit diesem Anschluss. Aus den sechs DOM-Fällen wird kein Browsernachweis des neuen Info-/Create-Transports abgeleitet.

Die eigene Fixture `canvas-yjs-authority-CrVWd3` endet laut Originalreceipt mit `phase: cleaned`, `passed: true`, `uncertain: false`, bestätigtem Entfernen der eigenen Datenbank und DATA; der Issuer bestätigt seinen eigenen Datenbankabschluss gesondert. Der echte Supervisorprozess endet mit Exit 0. Der zusätzliche unveränderte passive Observer endet ebenfalls mit tatsächlichem Exit 0: 48 Samples über 72,394 Sekunden, 19 beobachtete PID-/Startidentitäten, fünf Gruppen, kein Observerfehler. Die unabhängige frische Prüfung nach dem tatsächlichen Parentende bestätigt abwesende Parent-/Server-/Issuer-/Observeridentitäten, alle beobachteten Gruppen leer, Port 63300 ohne Listener, Runlock und DATA abwesend. Der Observer begann nach dem Startup; kurzlebige Kinder zwischen Samples sind keine vollständige Prozessinventur. Datenbankabschluss wird aus den Originalreceipts belegt, nicht aus einer behaupteten zusätzlichen SQL-Prüfung des Observers.

## Gesicherte Schritte im Worktree

| Commit | Inhalt |
| --- | --- |
| `2df5134a9` | Additive Guestbindung und unveränderte historische Sideeffect-/Restorebelege. |
| `e21be0890` | Echte Inviter-Authority, interne native Writer und monotone Member-Revokes. |
| `42f4b5040` | Tatsächliche Info-Zielreferenz im UI und optionaler physischer Original-Bootstrap-CAS. |
| `91434a13a` | Bestehender Backupspeicher für native Baselines, exakter nativer Restore und nachgeholter Scope-Sync. |
| `55cf40e6a` | Vollständig ausgeführte Agenten-Pfadregression statt unvollständigem PGlite-Exit. |

Vor jedem Commit wurde die gestagte GitNexus-Änderungsanalyse geprüft. Ihre Dateien bleiben innerhalb der jeweiligen benannten Schritte. Neue Symbole fehlen teilweise im älteren Index; die niedrige zusammenfassende Diffbewertung ersetzt nicht die ausdrücklich gemeldeten CRITICAL-Startup-/UI- und HIGH-Backup-Auswirkungen. TypeScript und die genannten tatsächlichen Laufzeittests sind gesonderte Nachweise.
