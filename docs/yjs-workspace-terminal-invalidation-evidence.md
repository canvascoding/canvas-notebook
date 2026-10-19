# Abschlussmeldungen, Dateiliste und begrenzte Editor-Wiederverbindung

**Aktuellerer tatsächlicher Stand V6/V7, 19. Oktober 2026:** Die vollständige echte Live-Ownerfolge besteht zweimal 16/16, zuerst mit privater Zeitmessung und danach frisch ohne Preload, auf denselben Produktquellen und mit allen bestehenden Schutzprüfungen und Zeitlimits. Gezieltes TypeScript und ESLint bestehen in beiden Läufen; der unabhängige READ-ONLY-Ressourcenabschluss umfasst 25 genau gebundene eigene Fixtures. [Originalbelege und Grenzen](./yjs-native-path-owner-live-acceptance-evidence.md). Die früheren V3-/V5-Ursachen bleiben ungeklärt; frischer Build, Browser- und SDK-Gesamtabnahme stehen aus. Die nachfolgenden Abschnitte behalten ihre jeweiligen historischen Quellenbindungen.

**Neuerer tatsächlicher Stand V3/V4, 19. Oktober 2026:** Der optionale Prepared-Adapter ist als `8f63dbbbf` isoliert committed; gewöhnliche15, Prepared15 und neue tatsächliche Katalog-PG4 bestehen. V3-Copy und der strengere vollständige Scene-SQL-Beobachter in V4 bestehen jeweils 10/10; V4 besteht außerdem öffentliche Move-/Delete-Tools11, Typprüfung und Lint mit unveränderten Quellenpins. V3-Owner16 endet nach elf bestandenen Gruppen diesmal bei einer Nichtmutationsassertion nach echtem Live-Room-Drain und Ownerabschluss, ohne den früheren Fünf-Sekunden-Abbruch. Der genaue fehlgeschlagene SQL-/Domain-/Dateivergleich ist noch zu ermitteln; parallele tatsächliche Hintergrundprojektion ist als mögliche Konkurrenzquelle belegt, keine Statusmutation behauptet. V7 bestätigt unabhängig den Abschluss von 20 genau gebundenen Fixtures. [Neue Originalbelege und genaue Grenzen](./yjs-prepared-storage-read-evidence.md). Die folgenden Abschnitte behalten ihre früheren gebundenen Prüfstände; vollständiger Live-/Browser-/SDK-Abschluss bleibt offen.

Stand: 19. Oktober 2026. Der Anschluss ist im Worktree integriert. Diese lokalen Teilprüfungen ersetzen weder die noch laufende vollständige Ownerfolge noch einen frischen Build-/Browser-/SDK-Gesamtnachweis.

## Verhalten

Die festen tatsächlichen Move-/Delete-Abschlussstellen, ein frischer nachgewiesener No-write-Abort und eine neue Copy-Veröffentlichung merken auf ihrer gehaltenen B eine PostgreSQL-Benachrichtigung vor. Copy betrifft ausschließlich den Zielworkspace. PostgreSQL liefert nach tatsächlichem COMMIT; ROLLBACK liefert keinen Hinweis. Ein verlorenes COMMIT-ACK kann deshalb bereits einen Hinweis ausgelöst haben. Historische Reads und abgeschlossene Recovery-Fastpaths erzeugen keinen neuen Hinweis.

Der separate Hinweis enthält ausschließlich die streng geprüfte Workspace-ID. Ein eigener PostgreSQL-LISTEN-Client übernimmt aktuelle Abonnements und synchronisiert nach Verbindungsaufbau/-wiederkehr erneut. Servercaches werden vor dem eigenen SSE-Hinweis invalidiert. Der Client prüft Eventsource-Generation und aktiven Workspace vor und nach synchronen Cache-/Storebenachrichtigungen; er aktualisiert Referenzcaches, Dateibaum und den bestehenden Such-Refreshschlüssel. Es wird kein Dateimutationsereignis erfunden und kein offener Editorinhalt neu geladen. Ein List-GET in einer anderen, selbst nicht abonnierten Replica bleibt eine gesonderte Cache-/Deployment-Abnahmegrenze.

Aktive Editoren und inaktive Tabs lesen danach die aktuelle Location über Dokument-ID und bestehende Autorität. Ein zeitlich und mengenmäßig begrenztes Wiederholungsfenster behandelt nur konkret markierte vorübergehende Lesefehler. Ein zusätzlicher Hinweis füllt ein noch offenes Budget nicht wieder auf. Authwechsel, Rechteentzug, Identitäts-/Lifecycle-/Representationwechsel und generische Fehler bleiben terminal. Eine Session darf erst nach bestätigtem ROLLBACK, SQL-Freigabe und Transportdisposal als sicher wiederholbarer reiner Lesefehler markiert werden. Y.Doc und lokaler Entwurf bleiben erhalten; Rejoin benötigt eine frisch autorisierte Session.

## Tatsächliche lokale Ergebnisse

Originale unter `/private/tmp/canvas-native-path-admission-8gusy9ys/`; alle Controller erhalten ursprüngliche Exits/Signale und Vor-/Nach-Quellhashes.

| Prüfung | Original und Ergebnis |
| --- | --- |
| FileWatcherService, FileWatcherClient, Live-Bridge, Listenermodell, Retrypolicy, aktiver Locationhook | Sechs Programme in `terminal-models-v1`, jeweils Exit 0 |
| Inaktive Location einschließlich Authwechsel, Parallelitätsgrenze, verzögertem Response und Workspacegeneration | Root-Programm `location-inactive-terminal-models-v3.log`, Exit 0 |
| Sessionstartup mit erhaltenem Schema-/Uservertrag und abgebrochenen Wiederholungen | Root-Programm `session-startup-terminal-models-v2.log`, 29/29, Exit 0 |
| Zwei echte Prozesse und tatsächliche PostgreSQL-Verbindungen: COMMIT, ROLLBACK, Workspacefilter, Disconnect/Resync und beendeter Listener | `notify-multiprocess-pg-principal-terminal-pg-v2.log`, Exit 0 |
| Tatsächliche authentifizierte Web-/Mobilehandler: Native-Advisory-Busy, tatsächliche Freigabe vor Retry, dauerhafte Busy sowie verlorene Rollback-/Close-/Disposalbestätigung | `native-reader-busy-pg-principal-terminal-pg-v2.log`, 36 PostgreSQL18-Familien, Exit 0 |
| Gezieltes TypeScript und Lint des gemeinsamen Anschlusses einschließlich neuer Owner-/Copytests | `scoped-types-owner-terminal-v16.log` und `scoped-lint-owner-terminal-v16.log`, jeweils Exit 0 |

Die Clientprogramme verwenden kontrollierte Adapter beziehungsweise JSDOM; daraus folgt keine echte Browser-/OAuth- oder PostgreSQL-Autoritätsabnahme. Der Prozess-Transporttest verwendet echte getrennte PIDs und Backendverbindungen, verändert aber keine Dokumente und beweist allein keinen DA04-Abort. Die Sessionhandlerfolge arbeitet auf eigenen migrierten Schemata mit tatsächlichen Locks, direkten Requesthandlern und der vorhandenen Gateausnahme; sie ist kein neuer Netzwerk-/Browsernachweis.

## Erhaltene negative Originale und Korrekturen

Die erste Typprüfung `terminal-validation-v1` scheitert an drei neuen Testfixtureproblemen: leere-Array-Assertions verengen später gefüllte Eventarrays auf `never[]`; tatsächliche Pool-Releases sind als `PoolClient` anzunehmen; die explizit bereinigte Kinder-ENV braucht das ohnehin später gesetzte `NODE_ENV`. Die engen Testkorrekturen erhalten alle fachlichen Assertions; V2 endet bei TypeScript und Lint mit Exit 0.

Die erste inaktive Locationfolge in `terminal-models-v1` endet mit rotem Exit beim erwarteten E-Request. Das Öffnen von E aktiviert E; die neu dynamische Aktivtabprüfung muss E daher korrekt überspringen. Die private instrumentierte Diagnose belegt null belegte Plätze und E als aktiven, übersprungenen Tab. Vor derselben unveränderten E-Assertion aktiviert die Korrektur ausdrücklich D. Private Gegenprobe und anschließendes Root-Programm bestehen; kein Produktguard wird geändert und keine Assertion entfernt.

Die beiden neuen tatsächlichen Owner-Testprogramme erhalten nach Roots unabhängigem AST-Vergleich alle elf ursprünglichen Path- und neun Copyfallkörper. Sie ergänzen echte produktive Notifyzählung, tatsächlichen B/XID-/Receipt-/COMMITnachweis und getrennte Serverbarrieren statt zeitbasierter Abwesenheitsannahmen. Ihre vollständigen 16-/10-Gruppenläufe sind separat noch abzuschließen. Ein im Quellenreview gefundener Copy-Testfehler ist vor Freeze korrigiert: Ein vergifteter MCP-Capture lehnt ab; er liefert keinen normalen Recoveryreturn.

Dateiaktions-Undo, Review Center und allgemeine Aktivierung bleiben aus. Legacy-Markdown, übrige Agenten-/PDF-/Such-/Skill-/Sandboxanschlüsse und öffentliche Dokumentationsauslieferung gehören weiter zum [vollständigen Plan](./yjs-document-authority-consolidation-plan.md).
