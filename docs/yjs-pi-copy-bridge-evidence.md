# PI Copy: tatsächlicher Anschluss an den zentralen Dokumentkern

Stand: 19. Oktober 2026. Geprüfte Ausgangsrevision `2cdd096a3`; der gebundene Produktpatch betrifft `agent-file-operations.ts` und `tool-file-formatters.ts`. Diese Teilabnahme schließt den PI-Copy-Fallback, keine vollständige MVP- oder Produktionsfreigabe.

## Verhalten

Aktive workspace-lokale Copy-Auswahlen gehen vor der alten physischen Quellzusammenfassung und Lifecycle-Lease durch die echte Native-Owner-Vorschau und anschließend denselben zentralen Ausführungsdienst. Die tatsächliche aktuelle PI-Tool-Invocation, gespeicherte Sitzung, Profilfreigabe und Workspaceberechtigung bleiben erforderlich. Owner-, Principal- und Lifecycle-Sperren sind unverändert.

Exakte Quell-/Zielmappings und `recursive:false` werden vor Wirkung geprüft; `expectedPlanId` bindet die Ausführung. Eine frische Operations-ID trennt Neuanlage von historischen Erfolgsbelegen. Erfolgsprüfung beruht auf bestätigtem zentralem Abschluss und den tatsächlichen Zielmappings, auch ohne physische Markdownprojektion. Physische Bytezahlen sind dann ausdrücklich `null`; der reale Toolformatierer zeigt „not available“. Unbestätigte Ausgänge werfen `NATIVE_COPY_OUTCOME_UNAVAILABLE` mit Original-Operations-ID und Prüfhinweis statt einer unbelegten Änderungsbehauptung. Owner-Fehler wählen niemals `fs.cp` als Ersatz.

Aktives workspace-lokales `overwrite=true` wird mit `NATIVE_COPY_OVERWRITE_UNSUPPORTED`/409 vor Seiteneffekten abgewiesen, auch bei vakantem Ziel. Deaktivierte Legacy- und Temp-/Outside-Workspace-Pfade behalten ihre bisherigen Grenzen. Review Center und Dateiaktions-Undo bleiben aus.

## Ausgeführte Prüfung

`node scripts/run-document-read-tool-dispatch-test.mjs scripts/pi-copy-rename-postgres-test.ts` verwendet die bestehende echte PostgreSQL-Fixture und ruft tatsächlich `copyAgentPaths` aus gespeicherten Agentensitzungen innerhalb echter `withAgentToolInvocation` auf. Keine ersetzte Autorität, kein direkter Owner-Aufruf und kein `fs.cp`-Stub.

Alle **6 Gruppen** bestehen in 50,877 Sekunden:

1. Native Kopie mit geändertem Basename, frischen Dokument-/Lineage-/Yjs-/Blockidentitäten und einzeln zugeordneten Selbst-/Ziellinks.
2. Native Quelle ohne physische Markdownprojektion; bestätigte zentrale Kopie ohne erfundene Bytezahl.
3. Assetlose Scene mit tatsächlichem Birth-Receipt, neuen Identitäten, gespeichertem Inhalt und portabler Zieldatei.
4. Ausgewähltes rohes Markdown verlangt echten Import; kein Raw-Fallback.
5. Tatsächliche schreibgeschützte Mitgliedssitzung wird abgewiesen.
6. Native/rohe Quellen mit `overwrite=true` und jeweils vakantem/belegtem Ziel bleiben vollständig unverändert.

Originalzustände, Registry, Lineages, Projektionen, Metadaten, History und `xmin` sowie originale Dateien mit Identitäten/Bytes bleiben unverändert. Unselektiertes rohes Markdown samt Alias/Selbstlink und nativer eingehender Aliasreferenz bleibt uninitialisiert erhalten. Die Negativorakel umfassen alle Domainzeilen/`xmin`, Tabellen-/OID-Inventar, SQL-Writes/Notify und den vollständigen privaten DATA-Baum. Ihre Grenze liegt nach tatsächlicher Session-/Skill-Kontextvorbereitung und um die gesamte echte Invocation samt Fehlerfinalisierung; die aktuellen Ownerprüfungen liegen darin.

Gezieltes TypeScript (18,202 Sekunden), Scoped-ESLint (2,219 Sekunden) und der bestehende Ergebnisformatierer-Test (0,384 Sekunden) enden jeweils mit Exit 0. Die Originalquellen bleiben während der gesamten Folge identisch. Unabhängig bestätigt: eigenes Schema und OID entfernt, eigene Sitzungen geschlossen, privates DATA entfernt, Originalprozess beendet, vier verwaltete Dienste unverändert gesund. Kein Container wurde erstellt oder neu gestartet.

Private Originalbelege: `/private/var/folders/bx/tjzzmjhn2qdcdyfc_l7hkv900000gn/T/canvas-m1-pi-copy-ybfihrha/validation4`.

- `terminal.json`: `85acbb6865b878ba8100bdf8b973729445762d9746dc84a07bcffdd47d015ea6`
- `independent-resource-report.json`: `7d9e53fca8d5bcc21f26761968f6b00613fbf5324d3fd7d23ef6a152e934f98c`
- Testquelle: `4a3688adc8162e251d83e90e3aacc81d5004b2a3078e53458652e59cc5c640c1`
- Produktquelle `agent-file-operations.ts`: `48ff4034e2c6387ede0dcf3ffc5abc04d5e48bf23f5192cbcb3a1c4e365f3755`

Vorherige Originalausgaben bleiben erhalten: erster TypeScript-Lauf scheiterte an zwei fehlenden lokalen Typannotationen im neuen Test; zweite Folge an einer falschen Erwartung zur nach Abschluss entfernten Stage; dritte Folge an der zu weit außen um den Kontextresolver gelegten DATA-Orakelgrenze. Korrekturen betreffen Testdiagnostik/-grenzen, keine gelockerten Dokument- oder Ownerprüfungen. Die beiden tatsächlichen Fehlversuche besitzen ebenfalls unabhängige Ressourcenabschlussbelege.

## Verbleibende Grenzen

Kein Nachweis für PI-Recovery nach Prozessabbruch, alle Temp-/Legacy-Konstellationen, allgemeines Overwrite, jeden Dateityp, OAuth, Browser-UI, Linux-Sandbox oder veröffentlichtes SDK. Vorhandene Owner-/MCP-Recoveryfolgen bleiben getrennte frühere Belege. Root-Aktivierung bleibt aus. Delete, echter Raw-Import/Link-Rebinding, interner Create-Schreibweg, Linux-Schreibschutz und finale gemeinsame Build-/E2E-/PR-Abnahme bleiben im MVP-Plan offen.
