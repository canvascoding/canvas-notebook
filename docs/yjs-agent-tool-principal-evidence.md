# Tatsächlicher Agentaufruf und gemeinsame Workspace-Principal

Stand: 16. Oktober 2026. Produkt-/Testcommit Root `3e23ff15fa7a14faf204527ccf380d7f530df65d`, identisch übernommen als QA `4d6ad059472fc1affd37522f1bd68a150f6406e4`. Diese Etappe schließt die bisher fehlende zeitlich gebundene Herkunft eines tatsächlichen Agent-Toolaufrufs und dessen aktuellen Workspacezugriff. Die Public-Fassade verwendet den neuen Principal noch nicht. Er erteilt weder Tool-/Operations-/Public-Consent noch Dokument-Admission, Dateisystem-, Yjs- oder COMMIT-Autorität. Das allgemeine Ready-Gate bleibt aus.

## Umsetzung

Der tatsächliche [Tool-Wrapper](../app/lib/pi/tool-runtime-helpers.ts) erfasst unmittelbar vor Cleanup, Toolausführung und Ergebnisaufbereitung eine eigene [Invocation](../app/lib/pi/agent-tool-invocation.ts). Eine gewöhnliche `runWithAgentExecutionContext`-Umgebung allein reicht nicht. Opaque Handles und private Register verhindern die Wiederverwendung kopierter oder serialisierter Objekte. Die eingefrorene Herkunft enthält ausschließlich primitive User-/PI-/Agent-/Workspace-/Turn-/Tool-/Callwerte; die `canWrite`-/`canShare`-Behauptungen eines Kontextobjekts werden nicht übernommen. Nullable Default-Agent-IDs und Legacy-Kontexte bleiben für normale andere Tools zulässig.

Invocation und registrierte Arbeit prüfen Ursprung, Abbruch, beendete Gültigkeit und bereits fehlgeschlagene Guards. Unbeobachtete registrierte Arbeit wird vor dem äußeren Abschluss abgewartet und darf keinen Erfolg liefern. Tatsächliche verschachtelte Toolaufrufe besitzen getrennte Handles und werden zugleich im Elternaufruf registriert. Die private Elternkette bleibt während eines Kindes gültigkeits- und abbruchgebunden. Nach dem Kind wird die vorherige ALS-Umgebung wiederhergestellt. Ein späterer tatsächlicher Cleanupfehler behält seinen Vorrang vor einem früheren abgefangenen Guardfehler.

Der neue [Workspace-Agent-Principal](../app/lib/workspaces/request-principal.ts) liest ausschließlich diese aktuelle Invocation. Seine Factory umfasst auch vorbereitende Connection-Freigabe, den vollständigen aufrufenden Transaktions-/COMMIT-/Cleanupcallback und eine letzte Invocationprüfung. Übergebene User-/Agent-/Sessionobjekte, eine fingierte BetterAuth-Sitzung und ein austauschbarer Validator sind keine Eingänge. Die neue Agent-Accessfläche nennt die PI-Sitzung ausdrücklich `piSessionId`; sie wird nicht zu einer Browser-`sessionId` umgedeutet.

Die Factory hält ursprüngliche PI-Datenbank-ID, Profil-ID/Revision und relevante Profil-/Workflowwerte fest. Auf derselben tatsächlichen B-Connection werden genaue PI-Zuordnung, Archivstatus, Workspace-/Root-/Scopewerte und Profilpins frisch geprüft. Konto/Ban, Seat, aktueller Actor, gespeicherter PI-Workspace und `Agent.canUse` verwenden die vorhandenen Resolver. Systemagenten durchlaufen Konto-/Seat-/Workspace-/`canRunAgent`-Prüfungen unabhängig vom bestehenden `MAIN_AGENT_ACCESS`-Shortcut. Aus der aktuellen Profilbindung ergibt sich keine neue Toolpolicy: `enabled_tools_json`/Workflowwerte sind Factory→B-Driftpins; die tatsächliche Tool-/Operationszulassung bleibt beim fachlichen Einstieg.

Agent-, Grant- und Memberrelationen erhalten dieselbe kurze SHARE-Schema-/Prädikatgrenze wie die bestehenden Account-/Workspace-Prüfungen. Auch neu eingefügte Grant-/Memberzeilen sind damit geschützt. Die genaue PI-Zeile wird mit `FOR SHARE NOWAIT` gehalten; ihre Relation erhält **ROW EXCLUSIVE**, das fremde gewöhnliche PI-DML zulässt und stärkere Trigger-DDL sperrt. ROW SHARE wäre dafür zu schwach. Die BetterAuth-Sessionrelation und deren FK gehören ausdrücklich nicht zur Agentvariante. Andere Chats und die gewöhnliche Browser-Sitzungsbereinigung dürfen weiterlaufen.

Die zuvor doppelte B-Phasenmechanik ist in einen privaten gemeinsamen Helfer überführt. Web, Guest und Agent behalten getrennte echte Captures, feste aktuelle Autorisierungsreader und ihre eigenen Accessformen. Keine frei übergebene Autorisierungsfunktion erreicht die öffentliche API. Der erste Webadapter wurde zunächst gegen alle 66 echten Member-/Metadatafamilien geprüft, anschließend der Guestadapter gegen 30 Familien; erst danach wurde der Agentzweig ergänzt.

## Tatsächliche Fehler und Grenzen

Die erste Invocationimplementierung bestand ihre ursprünglichen 16 Fälle, besaß aber keine gebundene Eltern-/Kindlebensdauer. Drei neue unveränderte Gegenproben scheiterten tatsächlich: Parent-Abort ließ lokalen Kinderfolg zu; ein abgelegtes Kind überlebte den äußeren Abschluss; ein geerbter geschlossener Elternkontext ließ ein neues Kind entstehen. Originaler Node- und Exec-Exit **1**, 16/19 bestanden. Nach der engen Korrektur bestehen genau dieselben 19 Fälle mit Exit **0**, ohne Skips oder Abbrüche. Diese Gegenprobe betrifft den neuen Entwurf, nicht einen nachträglich bewiesenen ursprünglichen Produktionsfehler.

Ein parallel gestarteter finaler Guest-Authoritylauf bestand 15 Fälle und scheiterte beim ersten Reservierungsfall mit tatsächlichem `ADMISSION_CONFLICT`, Exit **1**. Gleichzeitig lief die Guest-Servicefixture. Beide verwenden im selben PostgreSQL-Datenbankraum die feste Workspace-ID `redemption-space`; `collaborationAdmissionLockKey` enthält bewusst keinen Schemanamen. Damit sind ihre datenbankweiten Advisory-Locks trotz getrennter Schemas nicht unabhängig. Der genaue fremde Backend-Lockholder wurde nicht aufgezeichnet; die Zuordnung zur Parallelkollision ist eine aus Source und Laufüberschneidung abgeleitete Erklärung. Der getrennte Wiederholungslauf auf unveränderten Quellen besteht 30/30. Diese beiden bestehenden Fixtures sind künftig nacheinander auszuführen; der fehlgeschlagene Lauf bleibt erhalten. Kein Produktguard, Retry oder Testassert wurde deshalb abgeschwächt.

## Prüfungen und Ressourcenabschluss

| Prüfung | Tatsächlicher Abschluss |
| --- | --- |
| Invocation-Gegenprobe | Original Node/Exec Exit 1, 16/19; danach gleiche 19/19 Exit 0, 0 Skips/Cancel |
| Bestehender `pi-agent-turn-context-test.ts` | Node/Exec Exit 0; tatsächlicher Wrapper-/Await-/Turnrotationspfad erreicht den späteren Late-Errorfall. Das bestehende Script hat keinen eigenen finalen Completion-Sentinel; keine darüber hinausgehende neue Gesamt-E2E-Behauptung |
| Neuer Agent-Principal | Session `73531`, Exit 0, **49 echte PG18-Familien**, 0 externe Fetches und vollständiger normaler Finallyabschluss |
| Finaler Member-/Metadata-Stand | Session `99146`, Exit 0, **66 Familien** |
| Finaler Guest-Service | Session `81964`, Exit 0, **44 Familien** |
| Finaler Guest-Authoritystand | Paralleler erster Versuch `46000` Exit 1 nach 15 Fällen; getrennte Wiederholung `56086` Exit 0, **30 Familien** |
| Vollständiges cachefreies TypeScript | Session `23797`, Exit 0 |
| Scoped ESLint der fünf Produkt-/Testdateien | Session `56911`, Exit 0 |

Die 49 Agentfamilien belegen tatsächliche erfolgreiche Commits mit Systemagent, nullable Default-Agent und Special-Agentgrant. Abgewiesene Fälle umfassen bloßes ALS, kopierte/abgelaufene Principal, Legacy-Principal, Runtime-Abbruch, PI-Archivierung/Umzuordnung/Löschung/Wiederanlage, Profil-/Toolconfigdrift, Grant-/Seat-/ACL-/Banwiderruf, falsche Connection/Transaktion/Schema/FKs, Detached-/Reentrant-/Poisonfälle und die finale Prüfung nach einem echten Self-write. Negative Assertions akzeptieren benannte Domainfehler und vier bestehende konkrete Stored-Workspacefehler; beliebige PG-, Typ-, Syntax- und Transportfehler zählen nicht als richtige Autorisierungsablehnung.

Echte konkurrierende Backends prüfen vorhandene und fehlende Agent-/Grant-/Member-/Seat-/ACL-Prädikate sowie Trigger-DDL. Zugleich gelingen gewöhnliche Browser-Sessionänderung/-löschung und fremde PI-Zeilenänderung/-löschung/-anlage. Rollback-/Releasefehler bewahren ihre tatsächliche Identität bzw. vollständigen Aggregate. Ein absichtlich verlorener echter COMMIT-Reply erreicht die vorhandene Lifecycle-Recovery; die SQL-Zeile ist dauerhaft vorhanden, ein fehlender Recoverybeleg wird unverändert weitergegeben und die Mutation nicht wiederholt.

Alle PGfixtures schreiben ausschließlich in eigene neue Nonce-Schemas auf dem vorhandenen lokalen PG18. Die neue Agentfixture bestätigt im vollständigen Finally die Schemaentfernung. Erfolgreiche bestehende Fixtures schließen ihre eigenen Ressourcen über ihre normalen Finallyblöcke. Für alle drei Guest-Authorityläufe bestätigt zusätzlich eine frische unabhängige reine SQL-/Dateisystemprüfung die Abwesenheit ihres genauen Schemas und DATA-Verzeichnisses, einschließlich des fehlgeschlagenen Parallelversuchs. Die frische Prozessprüfung zeigt keine bekannten eigenen Test-, TSC- oder Lintprozesse mehr; sie ist kein vollständiger OS-Prozessbaumbeleg. Kein Apphost, Browser oder Container wurde gestartet.

Das private, nach Kopie und Hashvergleich gesicherte Belegpaket enthält 28 Originaldateien sowie das Manifest unter `/var/folders/bx/tjzzmjhn2qdcdyfc_l7hkv900000gn/T/canvas-agent-principal-evidence-1w47qccl/manifest.json`, SHA `aafa007e86e8a4a03db5e945e8b70570e10c54a50b639a64984c15349a1d84b5`. Verzeichnis/Dateien: 0700/0600. Es enthält Original-RED/GREEN-/Wrapperlogs und Exits, Root-Terminalausgaben, Quellpins, ASTvergleich, GitNexus-Scope und bekannten Ressourcenabschluss; keine ENV-Werte oder echten Nutzerdokumente.

Finale unveränderte Produkt-/Testpins:

```text
request-principal.ts                  365d44fed28ba7ecff8ee8cea0572aee84b620aba376c4caef5ddd2a8265fad6
agent-tool-invocation.ts               a1b6ce1ba0e8f261deff4f0b9f9434e0f0de96876b42a2c4f5afa011daca48b5
tool-runtime-helpers.ts                042b893b23a035758d04d7669edd94cc2b2b6ded7f4254d51c97974f9b84f6c6
agent-tool-invocation-test.ts          efb029126eb8f3eab734aecf8705d5f0eefc9e36068f29e65dcdb73d87be08a0
workspace-agent-tool-principal-test   60bf94d92736ad02737e087276dd82f0d5774e67cf645ba88a6621bea86350c2
```

Vor Edits wurde HIGH für `wrapToolWithExecutionContext` gemeldet (zwei direkte Aufrufer, zehn Symbole; normale PI-/Mobile-/Automationsflächen) und CRITICAL für die sechs geteilten Principal-Symbole (je nach Symbol zwei bis sieben direkte Aufrufer, bis 19 indizierte Abläufe). Staged `detect_changes` meldet LOW, fünf Dateien und 13 berührte Indexsymbole. Der veraltete Index verschiebt dabei Positionen; der tatsächliche ASTvergleich belegt genau die sechs geplanten vorhandenen Principal-Funktionen und den Tool-Wrapper als verändert, 53 andere Top-Level-Funktionen unverändert, keine entfernte Funktion. Neue private Helfer und die zwei Agentexporte sind ausdrücklich separat hinzugefügt.

## Nächster tatsächlicher Public-Anschluss

Die fachliche Public-Fassade muss den neuen Agentprincipal mit aktuellem Freigaberecht, ihrer tatsächlichen Tool-/Gatewayoperation und bestehender expliziter Veröffentlichung/Begründung verbinden. Der reale native Toolname ist `public_share_file`; progressive Gateways tragen ihren Gatewaynamen. Eine frei erfundene Gleichheitsprüfung auf `create_public_links` wäre falsch. Skillbridge und Automationen beziehen bereits gewrappte Tools über `getPiTools`; ein Python-Dateipfad oder `import canvas_skill` allein erteilt weiterhin keinen Zugriff. Direkte MCP-/HTTP-Programme benötigen ihre eigene tatsächliche Autorität.

Public Create/Policy/Revoke, anonyme Token-/Accesswriter und Owned-Lifecyclehooks bleiben gemäß [Public-Nachweis](./yjs-public-share-binding-evidence.md) offen. Reine Publicreader können ihre Kurzcodewrites ohne URLverlust verlieren: der vorhandene DTO-Helfer verwendet bereits den vollständigen Token-URL-Fallback. Vorhandene Shortcodes bleiben erhalten. Native Reads können den vorhandenen `readNativeCollaborationDocument` mit B-gebundenem `loadCollaborationStateOnConnection` nutzen; dieser unterscheidet Live-Sicht und dauerhaft bestätigte Version. Keine zweite Native-Readerimplementierung und kein künstlicher Raumabwesenheitsguard sind dafür erforderlich.

Diese Etappe ist weder eine allgemeine Public-/Datei-/Linkaktivierung noch die Auslieferung des API-/Python-SDK-/Standard-Skill-Pakets. Die frühere 40-Fall-Browserabnahme bleibt an ihrem damaligen Build gebunden. Eine neue vollständige Abnahme folgt nach den tatsächlichen fachlichen Anschlüssen; Review Center bleibt ausgeschaltet.
