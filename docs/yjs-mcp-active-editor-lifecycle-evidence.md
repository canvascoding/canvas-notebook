# MCP-Dateiaktionen mit aktiven Editoren: nachgewiesener Lifecycle-Blocker

Stand: 19. Oktober 2026. Der frische Produktionsbuild besteht; der tatsächliche OAuth-/Browserlauf endet mit **8 bestandenen und einem fehlgeschlagenen Fall**, ohne Skips, Timeouts oder Unterbrechungen. Eine erfolgreiche gemeinsame Move-/Delete-Browserabnahme liegt damit nicht vor. Die inzwischen korrigierte öffentliche Busy-Fehlerzuordnung schließt den fehlenden Live-Editor-Anschluss nicht ab.

## Originaler Build und Browserlauf

Gebundene Quellen: Root `3ccb819373e067aada5230a56bb1fe68059e8cda`, QA `ba8125738d656adfd1bfc2fafea66fbd9c4c7510`, Control Plane `27c8ce37da082244f006ca376068cde6b98845d5`. Private Originalbelege liegen unter `/private/tmp/canvas-mcp-path-controller9-t1_ctfmf/`; die private Fixture und ihre erhaltenen Protokolle liegen unter `/private/var/folders/bx/tjzzmjhn2qdcdyfc_l7hkv900000gn/T/canvas-yjs-authority-bp2fi6/`.

- Der ursprüngliche Buildprozess endet nach 708,640 Sekunden mit Exit 0. Der unabhängige Artefaktabgleich besteht mit unveränderten Quellen, nativer API V3 und Build-ID `build-TfctsWXpff2fKS`. Artefaktreport SHA-256: `eb22f46bd4c78772a7cc121ee5f44c11fcd15c7d766cde8e66e623ee7eacf41e`.
- Die acht bisherigen Browserfälle bleiben unverändert und bestehen tatsächlich. Fall 7 benutzt weiterhin sein ausdrücklich gebundenes älteres v4-SDK-Wheel; daraus entsteht kein OAuth-Nachweis für die neuen SDK-Dateiaktionen.
- Fall 9 erreicht nach sichtbarem Move-/Delete-Opt-in einen erfolgreichen nativen Move, die direkte Dateilistenaktualisierung, den vollständigen ID-Read, den Editor einschließlich Reload und die genaue Incoming-Linkumschreibung. Die Settings- und Move-Editoraufnahmen wurden visuell geprüft. Delete-Preview meldet anschließend `ready` mit einer Linkentfernung.
- Delete-Apply bei Testzeile 1326 liefert `PATH_UNAVAILABLE`. Der Originalstack ist `success` → `callPath` → Delete-Apply. Die Serverdiagnostik bestätigt HTTP 200 mit `MCP_TOOL_ERROR`; ein zusätzlicher Cleanupfehler ist nicht berichtet.
- Originalruntime und Queue enden jeweils mit Exit 1. Der unabhängige Postcheck bestätigt ausdrücklich `acceptancePassed: false`, `passed: 8`, `failed: 1`. Sein SHA-256 ist `90294dd100c46d680be2ba4dad394ef47a104a44f64a66014b137d74b1cf0a56`. Diese Belege werden nicht nachträglich als bestanden umgedeutet.

## Tatsächlich gespeicherter Fehler

Eine getrennte direkte PostgreSQL-Prüfung bestätigt die originale Datenbank anhand von Name, OID, Owner und Eigentumsmarker. Die Repeatable-Read-Transaktion ist read-only und erhält durchgehend keine XID; die Verbindung ist anschließend geschlossen.

Der tatsächliche Delete-Batch enthält `COLLABORATION_FILE_LIFECYCLE_BUSY`, Status `needs_recovery`, Phase `recovery` und Fortschritt 0/2. Für genau diesen Batch existieren keine Delete-Intents, Trashreceipts oder Delete-Completionreceipts. Der vorherige Move-Batch ist `applied`. Die vollständigen ausgewählten Originalzeilen samt `xmin` bleiben im privaten `original-failure-readonly-v1.json` erhalten, SHA-256 `91e6915d65c53d06ee4fcaf2ac2304c644bf9224c8c1e0ef4217341e28e00af0`.

Der [Delete-Owner](../app/lib/files/workspace-operation-job-lifecycle-owner.ts) verwendet für native Pläne den bestehenden allgemeinen Lifecycle-Guard mit `paths: ['']`. Der [Guard](../app/lib/files/workspace-file-lifecycle-guard.ts) weist aktive Room-Owner, lokale Verbindungen und konkurrierende Admission zurück. Im Test bleibt der Incoming-Editor ausdrücklich geöffnet. Damit ist ein konkreter ausreichender Busy-Auslöser vorhanden; welche einzelne Ownerzeile beziehungsweise welcher Lock im ursprünglichen Augenblick zuerst traf, wurde damals nicht separat gespeichert. Die ausgewählte Zeilenabwesenheit belegt keine allgemeine Nebenwirkungsfreiheit.

## Abgeschlossene Fehlerzuordnung

Der öffentliche [Normalizer](../app/lib/mcp/server/workspace-path-tool-contract.ts) kannte nur den Alias `WORKSPACE_FILE_LIFECYCLE_BUSY`. Der tatsächlich erzeugte Code `COLLABORATION_FILE_LIFECYCLE_BUSY` fiel auf `PATH_UNAVAILABLE` zurück. Die Korrektur ergänzt ausschließlich dessen exakte Zuordnung zu `PATH_BUSY` und HTTP-Fehlerstatus 409; der alte Alias bleibt erhalten. MCP-Toolfehler behalten ihre reguläre HTTP-Transporthülle und `isError`.

Die neue neunte reine [Vertragsgruppe](../scripts/mcp-server-workspace-path-contract-test.ts) instanziiert die tatsächliche `WorkspaceFileLifecycleBusyError`. Sie prüft direkte und verschachtelte Fehler, Caller-ID, identische strukturierte/Textantwort, vertrauliche Fehlertexte, unveränderte Eingaben und gespeicherten Recoverystatus. Unbekannte ähnliche Codes bleiben unbekannt; unbestätigtes COMMIT und echte OAuth-Challenges behalten ihren Vorrang.

Mit unverändertem altem Produktcode endet die neue Regression tatsächlich mit Exit 1. Nach der Korrektur bestehen alle neun Gruppen mit Exit 0. Gezielte Typprüfung und Lint bestehen. Der erste private Typecheck ließ vorhandene Ambient-Deklarationen aus und bleibt mit Exit 2 erhalten; nach Aufnahme dieser unveränderten Repository-Dateien besteht derselbe Quellstand. Originale und Reports: `/private/tmp/canvas-mcp-path-busy-diagnostic-er4r8bay/`.

Finale Codepins: Vertrag `9a0751a826fe0fbfd3e2e039a5f5a2312396aa8e596acd4b2de68637ac0664fe`, Regression `931846285fa54218f9249fc7dfef346c7e17ff5c9ff666252a450ee37a546af9`. Der frühere Produktionsbuild ist auf seine ursprünglichen Quellen gebunden und belegt diese spätere Korrektur nicht neu. Keine Schutz-, Retry-, Recovery-, Aktivierungs- oder Room-Release-Logik wurde durch die Fehlerzuordnung geändert.

## Erforderlicher vollständiger Live-Editor-Anschluss

1. Aus dem echten Claim, Original-A-Actor und gespeicherten Plan einen einzigen dauerhaften Admission-Request ableiten. Identität, Payload und Digest müssen durch Drain, bestehende Intents und Recovery gleich bleiben. Der heutige Move-Helper verändert seine Bindung zwischen fehlendem Intent und Native-Bundle; eine lose zusätzliche Vorabreservation reicht nicht.
2. Reservation und Drain-Auftrag in kurzen aktuellen autorisierten Transaktionen bestätigen. Der derzeitige äußere Workspace-Lock im [MCP-Dienst](../app/lib/files/workspace-operation-mcp-path-service.ts) muss vor dem anschließenden Warten freigegeben sein. Claimverlängerung und feste aktuelle Principalprüfungen bleiben erhalten.
3. Den bestehenden ticketgebundenen [Admission-Drain](../app/lib/collaboration/room-admission.ts) und [Server-Drain](../server/collaboration-server.ts) verwenden. Laufende Aktivitäten und echte Yjs-Bytes dauerhaft speichern und Quiescence beweisen; dabei keine Workspace-, Lifecycle-, Room- oder Save-Locks während des Wartens halten. Der Incoming-Browsertab bleibt geöffnet.
4. Danach die bisherigen tatsächlichen Ownerfences neu erwerben und Rechte, Claim, Originalplan und vollständigen Graphen erneut prüfen. Geänderte Inhalte bleiben erhalten und dürfen einen echten Plankonflikt auslösen. Nur die exakt eigene private Reservation darf zugelassen werden; keine allgemeine Skip-Option oder Guardlockerung.
5. Die vorhandenen Move-/Delete-Effekte und das Admission-Outcome auf derselben B2 atomar bestätigen. Delete benötigt diesen Anschluss für native Links, Archiv, Trash und Original-Completion. Explizites Recover verwendet dieselbe Operation unter aktueller Sitzung B; Original-A bleibt erhalten. Status und Preview starten keine Arbeit.
6. Offene Editoren müssen nach dem vorübergehenden Socket-Drain eine frisch autorisierte Session für dieselbe Dokumentidentität erhalten. Der derzeit dauerhaft blockierende `admissionBusy`-Zustand im [Client](../app/lib/collaboration/client.ts) benötigt einen geprüften Completion-/Rejoin-Anschluss. Ein Event allein darf keine Autorisierung ersetzen.

Abnahme: unveränderter Browserfall 9, aktiver Move-Editor, während Drain akzeptierte Peeränderungen, fremde Reservationen und ersetzte Owner, verlorene Reservation-/Release-/B2-Bestätigung, Rechteentzug und ausdrückliche Recovery derselben Originaloperation. Ein Schließen des Testeditors würde diesen Produktanschluss nicht belegen.

## Getrennter Ressourcenabschluss und Grenzen

Nach Sicherung der Originalfehlerzeilen wurden ausschließlich die beiden anhand von Namen, OIDs und Eigentumsmarkern geprüften eigenen Testdatenbanken sowie die anhand der ursprünglichen Inodes geprüften DATA-/TMP-Verzeichnisse entfernt. Alle 23 tatsächlich beobachteten ursprünglichen Prozessidentitäten und acht Gruppen sind beendet. Die vier verwalteten Container behalten ihre Identitäten und sind gesund; drei Healthendpunkte liefern HTTP 200. Die ursprünglichen Fehlerreceipts bleiben bytegleich `preserved`/fehlgeschlagen. Der gesonderte Cleanupreport SHA-256 ist `0a3402ce8f50a0df90d2c990e1c4a93f5aafc3bbeddf21acfab53e33ce55f6ff`; er ist kein nachträglicher Browsererfolg. Prozesssamples erfassen nicht jeden kurzlebigen Prozess.

Der Live-Editor-Anschluss, SDK-Lifecycle über erneuertes OAuth, Legacy-Markdown, weitere Datei-/Ordner-/Scene-Fälle, interne Agentenneuanlage, PDF-Import, Sucherweiterung, Skill-/Sandboxabschluss und tatsächliche öffentliche Dokumentationsauslieferung bleiben offen. Der ursprüngliche Produktionsfehler `PREVIEW_BLOCKED` ist weiterhin nicht als behoben nachgewiesen. Dateiaktions-Undo, Review Center und allgemeine Aktivierung bleiben aus.
