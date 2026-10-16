# Copy: ursprünglichen Auftrag dauerhaft binden

Stand: 17. Oktober 2026. Diese Etappe erweitert den vorhandenen Copy-Koordinator. Die [vorherige Plan-/History-Grundlage](./yjs-native-copy-foundation-evidence.md) bleibt erhalten. Allgemeine native Aktivierung, Dateiaktions-Undo und Review Center bleiben ausgeschaltet; kein Produktionsrollout.

Neue Copy-Aufträge speichern einen privaten `origin` im bestehenden `WorkspaceOperationRequest`: Version 1, ursprünglicher User-/Agenten-Actor samt expliziter Sitzung sowie beide vollständigen JobScopes. Der vorhandene kanonische Requesthash bindet diese Daten dauerhaft. Der [Decoder](../app/lib/files/workspace-operation-copy-origin.ts) erfasst ausschließlich unveränderliche Daten; er erteilt keine aktuellen Rechte. Gleicher Workspace verlangt identische Scopes. Aktuelle Sitzungen dürfen wechseln, ursprüngliche Belegpins bleiben erhalten.

Der [gemeinsame Dienst](../app/lib/files/workspace-file-operation-service.ts) erfasst Copy-Inputs vor dem ersten Await, einschließlich Workspace-/Options-/Auswahl-/Actorwerten. Tatsächliche Filesystem-Options müssen denselben Scope beschreiben. Bei Wiederaufnahme prüft er den gespeicherten vollständigen Request und Hash, Journal-Actor sowie aktuelle Actoridentität und Scopes. Der native Copy-Callback erhält ursprüngliche User-/Sessionpins; Linkwrites erhalten weiterhin die aktuelle Sitzung. Fehlender Legacy-Origin bleibt ausdrücklich unverändert. Er wird niemals aus heutigen Daten nachgetragen.

Der [Journal-Dienst](../app/lib/files/workspace-operation-journal.ts) bindet Origin und SQL-Identität; der [Executor](../app/lib/files/workspace-file-operation-executor.ts) vergleicht bei vorhandenen Aufträgen zusätzlich Origin-Präsenz, genaue Requestbytes und Hash. Das Quellenreview fand dabei einen veränderlichen Actor-Verweis über das Checkout-Await. Prepare erfasst jetzt sämtliche Identitätsprimitiven samt Actor vor diesem Await und verwendet dieselben Werte für INSERT und COMMIT-Wiederlesung. Die neue echte Checkoutbarriere bestätigt den Erhalt der Originalwerte trotz nachträglicher Mutation des Callers; ein Lauf gegen den fehlerhaften Zwischenstand wurde nicht ausgeführt.

Der [HTTP-Recovery-Endpunkt](../app/api/files/operations/[operationId]/route.ts) übergibt den tatsächlich angemeldeten User und dessen aktuelle Sitzung. Ein ursprünglicher gebundener Agentenauftrag kann dadurch nicht als konstruierter Agent aus einer Browseranmeldung fortgesetzt werden; der Actorwechsel ist ein ausdrücklicher Konflikt. GET-, Copy- und Agentenantworten behalten ihre begrenzten öffentlichen Felder. Ursprungssitzung und private Scopes werden dort nicht veröffentlicht.

## Lokale Prüfungen vor dem Browserlauf

| Prüfung | Tatsächlicher Stand |
| --- | --- |
| Origin-Helper | 21/21 echte Purefälle, Autor-Session42574 Exit 0. User/Agent, getrennte Sitzungen, vollständige Scopes, UTF-8/Bounds, unveränderliche Erfassung und strikte Shapes. |
| Origin am tatsächlichen Executor | 7/7, Root-Session20979 Exit 0; geänderte beziehungsweise fehlende Originaldaten und falsche Journalbindung werden vor der Completed-Abkürzung abgewiesen. |
| Gemeinsamer Dienst | Root-Session10439 Exit 0, 14/14; nach reinem Test-Overloadfix Autor-Session46814 erneut Exit 0, 14/14. Konkrete Callbacks, Inputs vor Await, Actor-/Scope-/Hashkonflikte, ursprüngliche Path- und aktuelle Link-Sitzung sowie Legacy. Dies ist keine HTTP-/ACL-/Dateisystemabnahme. |
| Originalregressionen | Unveränderte Executorfolge 16/16 (Session52298), ursprüngliches PGlite-Journal (Session21133 und nach dem Prepare-Fix erneut93514) und erweiterte echte Routenkörper mit ersetzter Auth-/Servicegrenze (Route-Chunk b4e001) jeweils Exit 0. |
| Echte PostgreSQL-18-Folge | Root-Runner19174 tatsächlich Exit 0, 8/8 Gruppen; 43 geöffnete/geschlossene Checkouts, drei verworfene Verbindungen, exakte Wiederlesung nach verlorenem COMMIT und Checkout-Mutation. |
| Vollständiges TypeScript | Erster Lauf27424 Exit 2 wegen eines AssertPredicate-Overloads im neuen Service-Test. Nach gezieltem Fix verlangt die Matrix ausdrücklich Error und Status409; vollständiger cachefreier Wiederholungslauf86998 tatsächlich Exit 0. |
| Lint | Alle elf geänderten/neuen TypeScriptdateien Root-Session86277 Exit 0. |
| Build / Browser / unabhängiger Abschluss | Noch offen; die neue Spec ist vorbereitet, aber nicht als bestanden ausgewiesen. |

Der private PG-Beleg liegt unter `/private/var/folders/bx/tjzzmjhn2qdcdyfc_l7hkv900000gn/T/canvas-copy-origin-check-uu78va5v/`. Childlog-SHA-256: `612935708955a74fca1764d4edb1083424936350175d813134447c3b7faaf0e7`. Die neue Folge prüft kanonische Speicherung, neue aktuelle Sitzung bei erhaltenem Origin, alle Scopefelder/Agentenbindung, fehlerhafte Daten vor Checkout, COMMIT vor/nach tatsächlicher Bestätigung, die konkrete Await-Mutation und bytegleichen Legacy-Vertrag. Ausschließlich ein eigenes Schema wurde mutiert. Ein unabhängiger Abschluss auf exakter Schema-/OID-/ApplicationName-Bindung folgt separat.

## Browserumfang und verbleibende Arbeit

Die neue [Copy-Origin-Spec](../tests/workspace-operation-copy-origin.spec.ts) soll auf Desktop und Mobile tatsächliche UI-Kopien von TXT und linkfreier Markdown-Datei, bytegleiche Originale/Kopien, gefilterten Operationsstatus sowie eine zweite echte Anmeldung prüfen. Die anschließende POST-Abfrage eines bereits abgeschlossenen Auftrags muss ohne zweite Kopie und mit unverändertem öffentlichen Status enden. Das ist ausdrücklich kein Nachweis eines unterbrochenen nativen Stages, privater Ledgerpins oder historischen D2-Resumes. Dafür bleiben die jeweiligen Backendprüfungen beziehungsweise noch offenen Anschlüsse maßgeblich.

Origin ist kein Ersatz für aktuelle Member-/Agentenautorität auf der echten gemeinsamen SQL-Verbindung. Der vollständige native Copy-Anschluss mit Clone-Linkrebinding, festem Owner/Mutationsverbindung, vorbereiteter Datei-/Ordnerveröffentlichung, Metadatenpolitik und historischer Recovery bleibt offen. Der historische Reader aus der vorherigen Etappe ist noch nicht produktiv angeschlossen. API/MCP/Agenten, SDK/Standard-Skill, progressive Suche, PDF-Anlage und Sandboxschutz sowie Gesamt-E2E bleiben Teil des Auftrags.
