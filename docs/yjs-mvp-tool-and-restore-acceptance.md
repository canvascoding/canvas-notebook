# MVP: Toolkonfiguration und Restore-Abnahme

Stand: 20. Oktober 2026. Produktbasis Root `a2f1a87c5cd6fd57c4d0f240f9723b0edf5eaa1f`, quelläquivalentes QA `bcbc634fd50930bd816dfea57b00c782dcba778f`, Control Plane `27c8ce37da082244f006ca376068cde6b98845d5`. Root und QA unterscheiden sich ausschließlich in zwei bereits dokumentierten Evidence-Dateien. Der folgende Testkorrektur-Commit wird nicht rückwirkend als getesteter Head ausgegeben.

## Zwei konkrete Produktkorrekturen

Die Main-Agent-Toolauswahl verwendet einen eigenen eng begrenzten Writer. Damit kann eine frische Instanz Tools speichern, obwohl ihr Legacy-Providermodell noch leer ist. Der vollständige Konfigurationswriter bleibt streng; beschädigte Konfiguration wird nicht durch Fallbackwerte überschrieben. Echte isolierte Storage-I/O-Regressionen, Routeguard-Tests und Scoped-ESLint bestehen. Der echte Gesamtcheck bestätigt anschließend auch `PATCH /api/agents/tools`, die verwalteten Agentdateien und Session-CRUD.

Beim Datenbankrestore bleiben die kanonischen Organisationseinstellungen und die Ziel-Teammitgliedschaft erhalten. Bisher wurden jedoch die dazugehörigen Ziel-Organisationsrechte durch die Source-ACL ersetzt: Eine echte Wiederherstellung erreichte COMMIT, danach antwortete die frische Anmeldung mit HTTP 403. Der Restorekern erhält jetzt die vollständige tatsächlich vorhandene aktive Zielowner-Permission innerhalb derselben Transaktion. Der importierte andere Sourceowner wird im betreffenden Zielorg als Admin eingeordnet, damit der bestehende Single-Owner-Index eingehalten wird. Es werden keine Lizenz-, Team- oder Credentialdaten für die Probe nachgesät.

## Frischer Produktionsbuild

Das originale `npm run build` besteht auf der oben gebundenen Produktbasis mit Exit 0. Der versiegelte QA-Proof wurde am `2026-10-20T11:46:28.299Z` geschrieben:

- Source-Fingerprint: `cdf52d65827f2c646d12164186acd02b7432037a4fcd2e1dd3128328c5a185e8`.
- Build-Fingerprint: `56282208e551f30f8f49dfdf9cd18f25805c66909ab2cc57b3264f526901b6d9`.
- Build-ID: `build-TfctsWXpff2fKS`.

Die tatsächliche Prüfung der gebauten Module bestätigt dieselbe Yjs-Instanz für Node und Checkpointmodule, konkurrierende Move-/Textbearbeitung und binäres Wiederladen. Root selbst besitzt kein separat als geprüft ausgegebenes Buildartefakt.

## Tatsächlicher SameOwner-COMMIT und fünf Schutzfälle

Im bereits durch normalen Bootstrap angelegten eigenen Source-System wird sein echter Snapshot per produktivem Export-/Stage-/Replacekern wiederhergestellt und committed. Ein frischer PostgreSQL-Client prüft danach die kopierten Tabellen, ursprünglichen nativen Zustände und vier nichtleeren dauerhaften Kohorten, die vollständige Ownerzeile sowie erhaltene Lizenz-/Team-/Organisationsdaten. Tabellen-OIDs, Fremdschlüssel, Trigger und Indizes bleiben korrekt.

Fünf echte Transaktionen prüfen gesperrte gemappte Benutzer, verlorenen Adminstatus, fehlende beziehungsweise beschädigte lokale Credentials und eine fehlende kanonische Zielowner-Permission. Alle fünf lehnen vor dem ersten tatsächlichen `TRUNCATE` ab. Nach ausdrücklichem ROLLBACK sind sämtliche Originalzeilen einschließlich xmin und die geprüften Datenbankstrukturen unverändert. Es werden keine SQL-Antworten gemockt. Diese Teilprobe ist ein SQL-Vertragstest; eine frische SameOwner-HTTP-Anmeldung wird daraus nicht abgeleitet.

Original: `/private/tmp/canvas-yjs-authority-QaXwxX/results/owner-regression-outcome.json`, SHA-256 `13fd755af7b2c664d8f2b7d25ca0b4510ad9d844352339360dbdb7dd3a9aaf6c`.

## Tatsächliches Zielsystem: COMMIT, Anmeldung und Weiterbearbeitung

Eine getrennte eigene Zieldatenbank erhält ihren normalen Bootstrap und dieselbe echte, normal verifizierte Lizenz für die eigene Instanz. Danach erfolgen Upload, Inspektion, Staging und der originale Offline-Restore. Ein echter Restore-Receipt und publizierte Originalbytes bestätigen den COMMIT.

Vor neuer Bearbeitung stimmen Registry, Yjs-Binary, Statevector, Lineage und die dauerhaften Kohorten mit dem Source-Snapshot überein. Ihre tatsächlichen Zeilenzahlen sind Starterinitialisierung **1**, Markdown-Importreceipts **3**, Native-Editpayloads **1** und Agentoperationen **1**. Der Kohortenhash ist vor und nach Restore exakt `aca795549818dbf5a8b10bfd40434cdcb13a346ae6eaddfdb35a4c717c174f42`. Die vollständige ursprüngliche Zielowner-Permission bleibt erhalten; alle weiteren ACL-Zeilen entsprechen genau der genehmigten Sourceowner→Admin-Anpassung. Neun zurückzusetzende Prozesstabellen sind leer, Fremdschlüssel und Trigger bleiben korrekt.

Ein neuer Zielhost und eine echte frische Zielowner-Anmeldung bestehen. Beide ursprünglichen Notizen werden vollständig per stabiler Dokument-ID gelesen, über die normale Edit-API verändert und erneut gelesen. Ursprüngliche dauerhafte Historyzeilen bleiben erhalten. Der gesamte originale Owned-Lauf endet mit Exit 0, `verifiedDocuments=2` und `genuineSourceAndTargetEdit=true`.

Originale: `/private/tmp/canvas-yjs-authority-QaXwxX/results/portability-outcome.json` und `results/restore-comparison.json`. Der Vergleich wird direkt im erhaltenen Source-Ergebnisordner geschrieben, bevor der reguläre Cleanup den verschachtelten Target-TMP entfernt. Die drei eigenen Datenbanknamen und OIDs sind anschließend unabhängig read-only als abwesend geprüft; Source-DATA/TMP und Targetroot sind entfernt. Die vier verwalteten Container bleiben unverändert gesund.

## Gesamtcheck: konkreter RED und Testkorrektur

Das originale `npm run test:all` wurde auf dem frischen Build tatsächlich ausgeführt. Die reale Modellprobe ist `PROVIDER_VERIFIED / ready`, ihre Dauer **1356 ms**; die tatsächliche effektive Auswahl ist bestätigt. Shutdown (9 plus 6 Fälle), Scheduler (8), portable CLI, Smoke, HTTP-Integration und Promptbuilder bestehen. Die Pi-Prüfung bestätigt die korrigierte Toolauswahl, verwaltete Dateien und Session-CRUD.

Danach endet der Gesamtcheck mit Exit 1: Der bisherige Test sendet `send_message` ohne die vom aktuellen normalen Appclient verwendete stabile `clientMessageId`. Der echte Serverlog belegt eine erfolgreiche Subscription und anschließend `INVALID_MESSAGE / A stable, consistent clientMessageId is required`. Der Timeout folgt vor dem eigentlichen Modellaufruf. Der neue enge Testpatch übergibt dieselbe UUID im Envelope und in `message.clientMessageId`; Subscription, Assertions, Fristen und Cleanup bleiben gleich. Protokoll-Vertragstests, Syntax und Scoped-ESLint bestehen. Die vollständige Wiederholung auf diesem korrigierten Teststand ist noch offen.

Original: `/private/tmp/canvas-yjs-authority-WQIJL8/test-all.log`, SHA-256 `d3fec80754af58ae5a03dbcdd38dddb8208500ffb6ca8d731c45e812e13d5b3b`. Der ursprüngliche Lauf und dessen DATA/TMP bleiben als Fehlerbeleg erhalten; beide eigenen Datenbanken wurden nach vollständigem Prozessschluss exakt bereinigt. Die breite Default-Playwright-Phase wurde noch nicht erreicht.

## Vollständige Wiederholung nach der Nachrichten-ID-Korrektur

Auf QA `97ebad800c818c331cbc0e38bdfad7971d810468` mit Control Plane `27c8ce37da082244f006ca376068cde6b98845d5` bestehen frischer Produktionsbuild und die echte Modellprobe. Das originale `npm run test:all` erreicht nach erfolgreicher Pi-Verarbeitung die gesamte Default-Browserauswahl. Tatsächliches Endergebnis: **234 bestanden, 218 fehlgeschlagen, 269 übersprungen und 88 nicht ausgeführt**; Exit 1 nach 3812554 ms, ohne Abbruch oder Deadline. Die vorherige Aussage „Browserphase noch nicht erreicht“ gilt ausschließlich für den erhaltenen früheren RED oben.

Originale: `/private/tmp/canvas-yjs-authority-emMvHK/results/test-all-outcome.json` und `test-all.log`. Log-SHA-256 `b66a213d2ae06b7b733403cfc16e51387ebd17ffae8c73b4608d67926e2b4798`. Die Browserartefakte sind dort unter `results/default-browser-test-results/` gesichert. Beide eigenen Datenbanken wurden nach Prozessschluss exakt bereinigt und unabhängig auf Abwesenheit geprüft; die vier verwalteten Dienste bleiben gesund. Quellen- und Buildbindung sowie die Grenzen der Fehlerklassifikation stehen im [Gesamtcheckbericht](./yjs-mvp-full-test-runner-gap.md).

Die zwei daraus belegten MVP-Produktfehler betreffen den Zugang zum Markdownquelltext nach blockierter Rich-Aufbereitung und die fehlenden präzisen Hinweise bei einem initialen blockierten Rename-Preview. Die erste Korrektur besteht 18/18 kontrollierte Browserfälle; die zweite besteht Client-/Dialogregressionen und unabhängiges Review. Diese Fixtureprüfungen ersetzen noch keine erneute echte App-/Persistenzabnahme. Veraltete Read/Edit- und Undo-OFF-Testerwartungen werden eng angepasst, ohne Inhalts-/Link-/Rechteorakel zu lockern. Andere rote Fehlerfamilien sind nicht vollständig erklärt.

## Integrierte Editor- und Previewkorrekturen

Commit `76ad27135` gibt nach einer tatsächlich validierten terminal blockierten oder nicht unterstützten Rich-Aufbereitung den vorhandenen beschreibbaren Markdownquelltext frei. Pending, Unknown und aktuelle Rechte bleiben geschützt. Der kontrollierte Browservergleich ergibt vorher 15/18 und danach **18/18**, ohne Skips. Die Fixture bindet keine echte Y.Text-Persistenz; ein erfolgreicher App-Reload wird daraus nicht abgeleitet. Originale: `/private/tmp/canvas-markdown-migration-source-resume-20261020/verification-manifest.json`, grüner Report SHA-256 `be73f653fc80f48c55c24332f2ebf3d6b7b9d0d9bf2f9396ecf38c49aa011f04`.

Commit `3061b3f29` erhält bei blockiertem initialem Rename-Autopreview ausschließlich begrenzte öffentliche Diagnosen, gebunden an Workspace, Quell-/Zielpfade und aktuelle Anmeldung. Der Dialog zeigt genaue HTML-/Importprobleme und kann die betroffene Datei über den bestehenden Lesepfad öffnen. Blocked erzeugt keine Operation und kein Apply/Polling. Client- und montierte Dialoggegenprobe wechseln tatsächlich von rot zu grün; **4/4 Dialogfälle**, 16 Attemptgruppen, Statusclient und vier Storefälle bestehen, ebenso Scoped-TypeScript und ESLint. Unabhängiges Review findet keine konkreten P1/P2. Originale: `/private/tmp/canvas-mvp-blocked-preview-diagnostics-20261020`, Patch-SHA-256 `7a7936d52c155de00c280912eb7ffea92003f665f57c3b744e866e771caf6a96`. Das sind Offline-/JSDOM-Prüfungen, keine echte Server-/Datenbankabnahme.

Die separaten Testkorrekturen `89eed5377` und `4e69c68bf` warten auf wirklich beschreibbare Rich-/Quelltextflächen, verwenden die verpflichtende Create-Request-ID und unterscheiden Rename-Preview von Apply. Bestehende Inhalts-/Link-/ID-/Rechteprüfungen bleiben erhalten; öffentliche Undo-Aufrufe müssen ausdrücklich `409 / FILE_OPERATION_UNDO_DISABLED` liefern. Reine Collection registriert 23 betroffene normale Regressionen; deren tatsächliche Ausführung und die erneute 29er-MVP-Abnahme plus Fokus stehen noch aus.

## Grenzen und Launch

Die frühere 29er-MVP-Browserabnahme plus Fokusfall bleibt an Root `716d82215` / QA `24c9d5992` gebunden. Der neue Restorelauf ersetzt diese Browserabnahme nicht. Weitere Ziel-Teammitglieder, neue pending Move/Delete/Copy-Faultfälle und der ursprüngliche noch nicht neu ausgelieferte Produktionsvorfall werden hier nicht als abgenommen ausgegeben.

Noch offen sind die integrierte Abnahme nach den jüngsten UI-Korrekturen, der rote vollständige Gesamtcheck und CI/Review am jüngsten PR-Head sowie gesondert Main-Freigabe und Produktionsauslieferung mit Beendigung alter Writer/Räume und Prüfung der tatsächlich aktiven Version. Fokussiertes Grün ersetzt das Produktionsgate nicht; ein Nutzer-Waiver liegt nicht vor. Die sieben breiteren Roadmap-Pakete bleiben nachgelagert. Review Center und Dateiaktions-Undo bleiben ausgeschaltet.
