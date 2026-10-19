# MVP-Launch: zentraler Dokumentkern

Stand: 19. Oktober 2026. Direkte Nutzerpriorität: ein zeitnah nutzbares MVP veröffentlichen. Der vollständige [Konsolidierungsplan](./yjs-document-authority-consolidation-plan.md) bleibt erhalten; dieser Meilenstein priorisiert seine erste Veröffentlichung. Die sieben offenen Roadmap-Pakete werden dadurch nicht als erledigt erklärt.

Aktueller Freigabestand: **noch nicht bereit für Main**. Die gemischte Markdown-Planungsgrundlage ist mit Root `2bb1f7210` / QA `1e51d4a8e` committet. Die verbleibenden Gates sind tatsächlicher Dateiaktions-/Importanschluss, zentraler interner Create-Schreibweg, Produktionsaktivierung samt Linux-Schreibschutznachweis sowie gemeinsame finale Abnahme und PR-Prüfungen. Die grüne Grundlage ersetzt diese Anschlüsse nicht.

## Geprüfter Ausgangspunkt

- Produkt-/Testquellen der vollständigen lokalen Neunerabnahme: Root `fb0d492d7`, QA `192d8458f`; danach nur Dokumentationscommit Root `831c67071` / QA `67523cbb5`.
- Frischer Originalproduktionsbuild, unabhängiger Artefaktabgleich und vollständige echte OAuth-/Browserfolge **9/9** bestehen, einschließlich Create/Import/Read/Edit, sichtbarem Editor/Reload, Copy sowie Move/Delete mit zentralen Links und erneuerter Sitzung. Alle 14 unabhängigen Abschlussprüfungen bestehen. [Originalbelege und Grenzen](./yjs-native-path-unlink-oracle-evidence.md).
- Die tatsächliche Live-Room-Backendfolge besteht zweimal mit **16/16**. Der einzelne ursprüngliche Produktionsfehler ist dadurch noch nicht als behoben nachgewiesen.
- `authenticatedNativeTextSessionEnabled()` enthält im Root weiterhin `const enabled = false`; die Neunerabnahme verwendet den separat aktivierten QA-Stand. Ein Merge mit diesem Schalter allein aktiviert den neuen Dokumentkern nicht.
- Frisch abgeglichenes `origin/main` ist weiterhin `1506927038b80036749266a56fb769dcb6e6d18c` und bereits Vorfahr des Root. Es gibt noch keinen PR für `codex/yjs-document-authority-plan`. Auf Root `2bb1f7210` umfasst der Branch 413 Commits und 1.098 geänderte Dateien gegenüber Main; der Mergeumfang benötigt ausdrücklich Review.

## Erster Veröffentlichungsumfang

1. Web-Editor mit unmittelbarer Bearbeitung unter tatsächlichen Rechten, kompakter Fokus-/Breitensteuerung, sicherer Persistenz und Reload.
2. Neue leere beziehungsweise inhaltsgefüllte Notizen, Einfügen von Text und kontrollierter Markdownimport über die zentrale Dokumentanlage.
3. Zentraler Read/Edit- und Create/Import-Zugriff über die vorhandenen API-/MCP-Verträge. Native Suche liefert begrenzte Treffer und stabile IDs für vollständiges versionsgebundenes Weiterlesen.
4. Verschieben/Umbenennen, Kopieren und Löschen unterstützter Notebook-Dokumente samt zentraler Linkpflege, aktuellen Rechten, Konflikten und Wiederaufnahme derselben Operation. Bestehende gewöhnliche Dateiabläufe müssen unverändert sicher bleiben. Noch nicht unterstützte Typen/Ordner-/Scene-Aktionen werden vor Seiteneffekten klar abgewiesen.
5. Agenten dürfen initialisierte Markdownprojektionen nicht unmittelbar überschreiben. Für freigegebene Dokumentfunktionen gilt derselbe zentrale Dienst.

Dateiaktions-Undo und Review Center bleiben ausdrücklich aus. Text-Undo im Editor ist davon getrennt.

## Verbindliche Launch-Gates

### M1 – Alltägliche bestehende Dokumente und Dateiaktionen

Die bekannte rohe/Legacy-Markdown-Lücke ist für einen nutzbaren Dokument-MVP ein Blocker: Eine nicht initialisierte Datei außerhalb der Auswahl darf nicht pauschal die gesamte Aktion blockieren. Reiner Read/Preview/Status darf dabei nicht migrieren oder schreiben. Tatsächlicher Import und Link-Rebinding benötigen Originalbytes, aktuelle Rechte, stabile Identitäten und gebundene Recovery.

Eine neue tatsächliche PG18-Gegenprobe auf unverändertem Produktstand Root `b64d85c52` bestätigt diesen Blocker: Ohne zusätzliche physische Quelle bestehen dieselben drei Vorschauen; nach Anlage einer vollständig lesbaren, unselektierten Markdown-Datei ohne Links werden Copy (`MANAGED_COPY_PLAN_UNSUPPORTED`), Move (`NATIVE_MOVE_PLAN_UNSUPPORTED`) und Delete (`NATIVE_SOURCE_IMPORT_REQUIRED`) abgewiesen. Alle sechs vollständigen NoWrite-Prüfungen bestehen, einschließlich Domainzeilen/`xmin`, Tabellen-/OID-Inventar und vollständigem DATA-Baum samt Identitäten und Bytes. Originalprozess endet mit Exit 1 nach 27,066 Sekunden; unabhängiger Ressourcenabschluss besteht. Der neue Test `scripts/workspace-operation-raw-markdown-boundary-postgres-test.ts` (SHA-256 `841f603e04d47bd93df1f5c0199e69f1332087fd255d67f2259ff8f3f6362c59`) und sein enger Runner-Eintrag sind noch nicht committete Umsetzungsvorbereitung. Private Originalbelege: `/private/var/folders/bx/tjzzmjhn2qdcdyfc_l7hkv900000gn/T/canvas-m1-raw-boundary-2nnwed4w`. Diese Gegenprobe belegt die offene Ursache, keine Korrektur oder Mutations-/Recoveryabnahme.

**M1-Grundlage umgesetzt, Owner-Anschluss offen:** Die additive Quellen-Evidence V3 bindet den vollständigen Namespace, native Zustände und echte physische Originalbytes samt Parserinventar. Gemeinsame Resolver-, Planner- und Compilerkerne berücksichtigen rohe Links und Aliase ausdrücklich; physische Quellen erhalten keine erfundenen Yjs-Identitäten oder Schreibanker. Unveränderte physische Quellen bleiben lesend beteiligt. Ausgewählte rohe Quellen und erforderliche Inhalts-/Linkänderungen verlangen weiterhin den anschließenden echten Import-/Rebindingweg. Die V1-/V2-Evidence-Datei und historischen Hashformeln bleiben erhalten.

Auf eingefrorenem Arbeitsstand bestehen TypeScript, Scoped-ESLint, **102 Node-Testfälle und elf Quellenbeleg-Familien**. Der tatsächliche direkte Vorher-/Nachhervergleich bestätigt identische JSON-Bytes für 36 V2-Graphen, 90 V2-Pläne, 93 V2-Compilerfälle und zwölf bisherige Daten-Captures. Reviewbefunde zu vorzeitiger Callbackausführung und späten Ressourcenlimits wurden durch echte RED/GREEN-Gegenproben geschlossen: keine ungeprüften Objekte vor dem Hash, gemeinsame Byte-/Linkgrenzen vor Kopie/Parse und eine optionale frühe Grenze für tatsächlich serialisierte JSON-Bytes. Der bisherige Aufrufvertrag des gemeinsamen Daten-Captures bleibt unverändert.

Die erweiterte echte PG18-Gegenprobe bestätigt **drei planbare V3-Grundlagen** einschließlich unveränderter READ-only-Copyquelle und vollständiger NoWrite-Orakel. Die tatsächlichen öffentlichen Copy-/Move-/Delete-Owner bleiben dagegen beim alten Vertrag und scheitern weiterhin mit den drei ursprünglichen Codes; der originale Gesamttest bleibt ausdrücklich **Exit 1**. Originalquellen bleiben während der Folge gleich. Unabhängiger Ressourcenabschluss besteht mit entferntem eigenem Schema/OID, geschlossenen Backends, entferntem DATA, beendetem Originalprozess und unverändert vier gesunden verwalteten Diensten. Neue Originalbelege: `foundation-verification` unter demselben privaten Pfad; `terminal.json` SHA-256 `881b60570ca4d988ad0a2e51f8a49ce8b0472df16e6fe88da5d5b3c24c523e8f`, `independent-resource-report.json` SHA-256 `d1555d538cf354ac0965c3d5aca25ec18e7dc8b7576a0012580cce7620657b55`. Die erste Roh-Gegenprobe bleibt historisch erhalten. Diese Grundlage schließt M1 nicht; als Nächstes folgt der gebundene V3-Anschluss an die bestehenden Owner, zuerst Move.

Die zuvor betroffene Produktionsdateiaktion beziehungsweise eine inhaltlich und strukturell passende erhaltene Gegenprobe muss den tatsächlichen Fehler schließen. Die bisherige Neunerfolge verwendet neu nativ angelegte Dateien und ersetzt diesen Nachweis nicht.

Rein physische Moves, physisches Delete, native Ordner-Deletes und Scene-Move/-Delete sind keine bereits abgenommenen allgemeinen öffentlichen Fähigkeiten. Für das MVP müssen die unterstützten Wege sauber funktionieren und die übrigen Fälle vorhersehbar ohne Teilmutation gesperrt bleiben. Der alte Copy-Overwritepfad mit `linkStatus: incomplete` muss zentral angeschlossen oder gesperrt werden; eine als erfolgreich verkaufte unvollständige Linkpflege ist kein MVP-Vertrag.

### M2 – Produktionsaktivierung und einheitlicher Schreibweg

Die eigentliche Aktivierung wird erst nach belegtem Schema-/Migrations-, Ticket-/Room-, Lifecycle- und Writeranschluss geändert. Kein Test-Environment-Bypass wird als Produktionskonfiguration verwendet. API-/Toolverfügbarkeit und UI müssen dem tatsächlich freigegebenen Umfang entsprechen.

Der auf Produktion eingesetzte Linux-Agentenpfad muss rohe Projektionswrites aus Shell/Python/Kindprozessen und Skills tatsächlich verhindern. Fehlende Isolation darf nicht auf freies Exec zurückfallen. Weitere Plattform- oder Launcherwege dürfen nachgelagert bleiben, wenn sie für den MVP nicht freigegeben sind und sicher geschlossen bleiben.

Die vorhandene Landlock-Shellprobe allein genügt dafür nicht: Sie prüft einen anderen C-Launcher und kann bei dessen Fehlen erfolgreich überspringen. Der tatsächliche Linuxpfad über den isolierten Python-Launcher benötigt eine passende echte Probe und einen verpflichtenden CI-Aufruf; bislang fehlt dieser Workflowanschluss.

Bereits vorhandene interne Native-Editwege müssen unter echter Agentenautorität funktionieren. Noch fehlende interne Neuanlage darf keinen unkontrollierten Markdown-Fallback öffnen; vor deren Freigabe ist sie an den bestehenden zentralen Createkern anzuschließen. Externes MCP-Create ist separat bereits Bestandteil der Neunerabnahme.

### M3 – Gemeinsame Abnahme und Main-Merge

Auf exakt dem vorgesehenen MVP-Code- und Aktivierungsstand: frischer `npm run build`, gemeinsame UI-/E2E-Abnahme für Editor/Create/Paste/Markdownimport/Reload und die freigegebenen Datei-/Linkaktionen; API/MCP-Read/Edit/Create sowie Berechtigungsentzug und historische Recovery bleiben enthalten. Bestehende Dokumente, unterstützte physische Dateien und die Legacy-Gegenprobe werden ausdrücklich einbezogen. Linux-Schreibschutz und die normalen nicht aktivierten Bestandswege benötigen passende echte Regressionen.

Danach konkret abgegrenzten PR erstellen/aktualisieren, erforderliche CI-Prüfungen vollständig grün abwarten, sämtliche menschlichen und automatischen Findings bearbeiten und erst dann nach `main` mergen. Ein grüner Neuner allein ist weder Gesamtfreigabe noch Produktionsnachweis. Nach Auslieferung folgt eine gesonderte Prüfung der tatsächlich ausgelieferten Version und des aktiven Funktionsumfangs.

## Nachgelagerte Roadmap, weiter offen

Nicht jeder bereits geplante Zusatz muss die erste Veröffentlichung aufhalten: vollständiger installierter SDK-Copy/Move/Delete-OAuth-Lifecycle und Veröffentlichung des Pythonpakets, isolierter SDK-Runtimeadapter, zentraler PDF-Parseranschluss, Suche über physische/Scene-/PDF-Inhalte sowie standardmäßig ausgelieferter Documents-Core-Skill bleiben Folgearbeiten. Öffentliche SDK-Anleitung und `/docs`-Auslieferung bleiben an tatsächlich verfügbare Versionen gebunden. Bestehende Paketquellen sind keine veröffentlichte PyPI-Distribution.

Der zusätzliche Zehner-Testkandidat ist vollständig privat gesichert unter `/private/tmp/canvas-sdk-path-oauth-e2e10-candidate-20261019`. Gezieltes TypeScript, ESLint, Python-3.10-Syntax und reine Collection von zehn Fällen bestehen; tatsächliche Zehner-Browserabnahme fehlt, ein kleiner Inventargrenzen-Reviewpunkt bleibt offen. Frische installierte Wheel-/Quellparität und Preflightbelege liegen unter `/private/tmp/canvas-sdk-path-oauth10-validation-kksi17od`. Diese noch nicht abgenommene Testharnesserweiterung wurde zur MVP-Priorisierung aus dem Root zurückgenommen; keine Produktänderung oder Nutzerarbeit ging verloren.

## Nächster Umsetzungsschritt

M1 zuerst schließen: Quelleninventar von tatsächlichem Schreibset unterscheiden und den existierenden zentralen Import-/Rebindingkern für gemischte Markdownbestände anschließen. Parallel dürfen Produktionsaktivierung und Linux-Schreibschutz quellenbasiert auf reale MVP-Blocker geprüft werden. Zusätzliche SDK-, PDF-, Such- oder Skillfeatures werden während dieser Launch-Gates nicht weiter ausgebaut.
