# I-03b: authentisierter Markdown-Staging-Writer

Status: **Interner Writer abgeschlossen; erste Dateiveröffentlichung und Routeanschluss bleiben offen.** Die finale Source stammt aus den Autorcommits `61102025ba0887adc94686273f252f392e35096a` und `494b19fe3e93794a831c01cdc17f55735885dabe`. Root prüft und integriert exakt diese beiden Source-/Testdateien im Worktree `824c` auf Basis `7beb6a43b`.

## Vertrag

Der neue private Eingang [persistAuthenticatedMarkdownUploadFile](../app/lib/collaboration/markdown-file-import-persistence.ts) akzeptiert ausschließlich die acht Intentfelder eines gebundenen Uploadversuchs. Ein callerbereitgestellter Workspace, Rohbytes, Permissionflag oder `validateAuthority`-Callback ersetzt keine aktuelle Berechtigung. Originalrequest, User/Session, vollständiger Workspace einschließlich Customer/Project/Owner/Root sowie Datenbank-/Schema-OID und unveränderter SQL-Suchpfad werden vor den jeweiligen Await-Grenzen gebunden.

Die aktuelle Uploadquelle hält die echten Session-SH/File-EX-Fences über den gesamten Versuch. Innerhalb dieser Lifetime hält die tatsächliche Lifecycle-Ownerverbindung A die Workspace-/Dateiguards über die native Mutation B und gegebenenfalls die frische Verifikation C. B und C verwenden fest gegenwärtiges `canWrite`; die finale B-Prüfung erfolgt nach tatsächlicher Receipt-/Native-/Registry-DML vor COMMIT. Historische Bytes und Receipts erlauben keinen Zugriff nach Cancel, Ablauf, fehlendem Upload oder inzwischen abgeschlossenem Quellupload.

Dieser Eingang ist `createOnly`: tatsächliche physische Abwesenheit wird vor und nach DML sowie nach B-/C-Close unter A geprüft. Eine vorhandene leere Datei ist ebenfalls kein neues Ziel. Native Registry/Lineage, semantischer Anfangszustand, Schema und Vektor werden zusammen geprüft; der pristine Registry-CAS bindet auch Customer, Project und sämtliche ursprünglichen Scopefelder. Die Receipt-Trigger nutzen ihren bekannten normalisierten SQL-Namespace, bevor der Principal erfasst wird; eine spätere Realmabweichung wird dadurch nicht verdeckt.

Bei unklarer COMMIT-Antwort muss B nachweislich verworfen/geschlossen sein, bevor C aktuelle Rechte, volle ursprüngliche Identität, eigenen unveränderlichen Receipt und gültigen jetzigen Nativezustand prüft. Die Mutation wird nicht wiederholt. Ein Closefehler liefert keinen behaupteten Importerfolg, auch wenn tatsächlich committed wurde. Erste Projektion und dauerhafte Attribution des physischen Ziels gehören weiterhin zu I-04.

## Tatsächliche Gegenfälle und Validierung

Der Autor reproduzierte mit FK-gültigem Customer einen fremden pristine Registry-Scope, der vor der engen CAS-Korrektur tatsächlich Nativezustand und Receipt anlegte. Root prüfte außerdem einen echten A-Close mit anschließender `throw undefined`: der frühere Undefined-Sentinel ließ den Promise trotz Fehler als `applied` auflösen. Explizite Failureflags im neuen Eingang erhalten jetzt auch diesen Fehler. B-/C-Close- und B-Ausführungsgegenfälle bleiben getrennt; die Matrix prüft tatsächlichen Backendabschluss, freie Kernel-Fences und unveröffentlichtes Uploadziel.

Root bestätigt **15/15 echte PostgreSQL-18-/Auth-/Dateisystemfamilien** aus [authenticated-markdown-upload-postgres-test](../scripts/authenticated-markdown-upload-postgres-test.ts), einschließlich:

- echter Cookie- und Bearerrequests, unverändertem Byteprofil, read-only Ablehnung und callergefertigter Pseudoauthority;
- vorhandenen/aliasierten Zielen, fremdem initialisiertem Ziel, Registry-/Lineage-/Customerkonflikten und falschem SQL-Realm;
- Final-Revoke, Session-/Workspace-/Root-/Customerwechsel nach echter DML, verspäteter Zielanlage und Uploadablauf;
- gehaltenen Session-/File-Fences bis B-/C-Close, verlorenem COMMIT, fehlgeschlagenem B-Dispose und frischer C-Autorisierung;
- korruptem/quarantänisiertem Nativezustand, Fehlern einschließlich Undefined-Rejections sowie Cancel/Missing/Completed ohne Wiederbelebung historischer Quelle.

Die eigene PG-Fixture benutzt UUID-Schema und privates DATA am verwalteten lokalen PG18; es wird kein Container gebaut und kein fremder Namespace geändert. Nach dem Rootlauf sind alle `authenticated_staging_*`-Schemas, Fixture-Sessions und zugehörigen temporären Stagingroots entfernt; der beobachtete Testprozess ist beendet. Vollständiges TypeScript mit 8 GiB und `--incremental false`, scoped ESLint und Diffprüfung bestehen ebenfalls.

Root bestätigt exakt beide finalen Autorbytes, 29 von 30 alten Funktionskörpern unverändert und vierzehn vollständige geschützte Lifecycle-/Principal-/Reader-/Upload-/Route-/Originalsource-Module bytegleich zur Basis. Der einzige veränderte alte Körper ist `executeCapturedMarkdownImportOnConnection` mit vier engen Stagingzweigen. Der vorherige Impact zeigt einen direkten indizierten Caller, ein Modul, LOW und keine indizierten Prozesse; dynamische Route-/Callbackreichweite ist damit nicht vollständig bewiesen. Der neue private Eingang war auf der Basis noch nicht indiziert und hatte UNKNOWN.

Finale SHA-256: Persistenz `2cef12032412f99db188e22150b17ee216d4fa802f4897e7b172646c06d8b04c`; Test `ee73580cb1ec26f10aee06c53548b6b8818c7fc2d622cfb04b12586d1ab444e7`.

Kein Uploadabschluss, HTTP-/Mobile-/MCP-Dispatch, Targetpublish oder globaler Sessiongate wird aktiviert. Dies ist ein echter serverinterner Writerbeleg; Browser-, Native-Mobile-Geräte- und Produktionsabnahme dieses Anschlusses bleiben offen. I-04, I-05 und I-06 folgen in der Reihenfolge des [Create-/Paste-/Vollimportplans](./markdown-create-paste-full-import-integration-plan.md#8-umsetzung-in-abgeschlossenen-schritten).
