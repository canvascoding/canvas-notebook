# Native MCP-Copy: reiner Status und ausdrückliche Wiederaufnahme

**Historischer Status-/Recoverstand:** Die damals noch offene kanonische Größenprüfung ist inzwischen im [Requestbudget-Nachweis](./yjs-native-copy-request-budget-evidence.md) lokal abgenommen. Öffentlicher Dienst-/Tool-/SDK-Anschluss bleibt ein eigener offener Schritt.

Stand: 19. Oktober 2026; Originaltests am 18. Oktober 2026. Dieser Schritt ergänzt die tatsächlichen internen Status- und Recoveryeingänge auf dem zuvor abgenommenen MCP-Copy-Owner. Öffentlicher MCP-Handler, Dienst-/Ansichtsanschluss, SDK-Dateiaktionen und kompilierte Gesamt-E2E-Abnahme bleiben offen. Der separat vorbereitete Wirevertrag ist noch nicht integriert oder öffentlich angeboten.

## Feste Eingänge und gemeinsame Belege

`recoverWorkspaceNativeCopyOperation` führt genau einen ausdrücklich angeforderten bestehenden Originalauftrag aus. Execute und Recover verwenden dieselbe private Engine mit fest intern gewähltem Modus. Im vorhandenen echten Owner-Lock verlangt Recover nach aktueller Berechtigung einen bestehenden Header oder Originalstage. Fehlen beide, endet der Aufruf vor `createStage` mit `NATIVE_COPY_OPERATION_NOT_FOUND`/404. Die neue separate Fehlerklasse erweitert den breit genutzten bisherigen Hubfehler nicht. Vorhandene Autorität, Journale, Stages, unveränderliche Original-A-Zuordnung sowie feste B1-/B2- und Asset-/Linkphasen bleiben erhalten. Eine neue aktuelle SID_B ersetzt keinen ursprünglichen Auftragskontext.

`readMcpWorkspaceNativeCopyOperationStatus` verwendet einen eigenen tatsächlichen SQL-Checkout. Er verlangt vor Poolbezug den echten opaken aktuellen Copy-Handle. C1 prüft aktuelle Quelle-/Zielrechte auf RC/RW, bindet den kanonischen ursprünglichen Auftrag und pinnt Backend/start, Datenbank-/Schema-/Journal-/Schritt-OIDs, Suchpfad und native/Scene-Receipt-Storage. Die getrennte RR/RO-Phase ohne zugewiesene XID liest einen begrenzten Journalsnapshot und dieselben bestehenden vollständigen Abschlussbelege. C2 prüft aktuelle Rechte und die ursprüngliche Auftragsbindung erneut; erst nach tatsächlichem COMMIT und bestätigtem Verbindungsabschluss wird ein Ergebnis zurückgegeben.

Der private Statusframe bindet dieselbe tatsächliche Verbindung und virtuelle Historytransaktion. Er ist nur im festen Leser herstellbar und erteilt keine Owner-, Lease-, Schreib- oder Recoveryfähigkeit. Der obere bisherige Historybody ist nach Rücktausch ausschließlich seiner vier privaten Sessionassertionen bytegleich zum vorherigen Body. Zwei feste Exporte wählen intern Owner oder MCP-Status; der globale Ownerguard sowie die unteren Native-/Scene-Historyvalidatoren bleiben unverändert. Fehler, verschachtelte Verwendung und unbestätigter Verbindungsabschluss führen nicht zu einer erfolgreichen Statusantwort.

Journalstatus und Schrittzahlen sind eine beobachtete Momentaufnahme, kein eigener Mutationsbeleg. `completion.status: confirmed` wird nur nach der vollständigen bisherigen Completion-/Receiptprüfung ausgegeben und beschreibt historische Kopierziele. Es werden keine heutigen Dokumentversionen aus Pfaden oder alten Clonebelegen erfunden. Der Statuspfad öffnet keine Stage, kein Ziel, keine Projektion und keinen Blob, erzeugt keine Dateisperre und ruft weder Execute, Recovery noch Ansichtsfinalisierung auf.

Ein fehlender Journalheader endet `NATIVE_COPY_STATUS_NOT_FOUND`/404. Ein Originalstage kann bereits vor B0 dauerhaft vorhanden sein. Diese Antwort beweist deshalb keine Abwesenheit eines Auftrags und erlaubt keinen neuen Mutationskey oder automatischen Applyversuch; der ursprüngliche Schlüssel und Aufruf bleiben erhalten.

## Tatsächliche Abnahme

Die drei Originalfolgen liefen am 18. Oktober 2026 seriell gegen PostgreSQL 18; alle endeten mit Exit 0 ohne Signal. Die unabhängige Ressourcenprüfung folgte am 19. Oktober 2026.

| Folge | Tatsächliches Ergebnis |
| --- | --- |
| Echter MCP-Copy-Owner einschließlich Status und Recover | 9/9, Originalexit 0 |
| Bestehender Web-/PI-Copy-Owner | 26/26, Originalexit 0 |
| Bestehender Copy-Metadaten-/Scene-Owner | 15/15, Originalexit 0 |

Insgesamt bestehen **50 tatsächliche Prüfgruppen** auf den unten gebundenen Quellen. Die frühere 109-Gruppen-Abnahme bleibt ein eigener historischer Quellenstand und wird hier nicht als erneut ausgeführt ausgewiesen.

Die neue Folge behält ihre bisherigen fünf echten Ownerfälle und ergänzt abgeschlossenen reinen Status unter echter erneuerter SID_B, unbekannten Recover ohne Neuanlage, einen tatsächlich vor B0 erhaltenen Originalstage, Status-404 ohne dessen Veränderung und anschließende ausdrückliche Wiederaufnahme. Der Vor-B0-Fall entzieht den tatsächlichen Zielgrant über eine unabhängige Verbindung nach Stagepersistenz und vor der ersten Berechtigungsphase; das ist kein simulierter Stage oder Autoritätsmock. Die bestehende verlorene B1-Bestätigung wird erst nach tatsächlichem COMMIT ausgelöst und nun über reinen pending Status und ausdrücklichen Recover fortgesetzt.

Gefälschte, entkommene und echte falsche Brands, ein anderer tatsächlicher OAuth-Client, nur lesbares Ziel sowie widerrufener Quellgrant bleiben abgewiesen. Eine weitere reale Grantlöschung nach dem tatsächlichen History-COMMIT verhindert durch C2 jede erfolgreiche Antwort. Domänenzeilen samt SQL-`xmin` und vollständige Dateisystemidentitäten bleiben bei reinen Statusaufrufen unverändert. Der SQL-Beobachter kontrolliert ausgeführte Statements, ohne tatsächliche Autorität, Writer oder Ergebnisse zu ersetzen. Seine unabhängige Adminverbindung führt die ausdrücklich geprüften Widerrufe aus.

Gezieltes TypeScript einschließlich der neuen Suite und Scoped-Lint enden mit Exit 0. Zwei unabhängige Quellenreviews des Status-/Historysplits sowie der zusätzlichen echten Testfälle fanden keinen konkreten Blocker. Der Quellenrunner bindet das neue Statusmodul und die bestehende Scene-History an denselben tatsächlichen ESM-Modulgraphen.

## Quellen und Abschluss

Die privaten Originalberichte, Logs, eingefrorenen Quellen und Prüfskripte liegen unter `/private/tmp/canvas-mcp-copy-public-u_tv6p4u/`. Ausgangsstände sind Root `30daff9f99298ea6e5555198c5de6bbc35706153` und QA `a88992f0a23ab85d5eaa4c2af0cd1e862517243b`; die fünf Code-/Testquellen sind in beiden Worktrees bytegleich.

| Geänderte Quelle | SHA-256 |
| --- | --- |
| `app/lib/files/workspace-operation-native-copy-owner.ts` | `2b6fab513d4e2cd5cf99c6fbe8eb184e9e93fc21cfe2b867bd016b55536b8d43` |
| `app/lib/files/workspace-operation-native-copy-phase-read.ts` | `e5f8879044719e6622a866bc6b127098c1553a0e34cfb6a2682c2e54b3a8a061` |
| `app/lib/files/workspace-operation-native-copy-status.ts` | `9a9ead9df36429492c007c09165e3ae8076ead08cc98f3f44af99f418b8ba44e` |
| `scripts/direct-mcp-native-copy-owner-postgres-test.ts` | `8e722d44b59cc15b8f5d24369487126b145330e511305037c7616c5e79fba725` |
| `scripts/run-document-read-tool-dispatch-test.mjs` | `1bd2ba7b4c439024ee583136efc0f7edcacb02bee6da242ba2363ec99cd2d1c1` |

| Originalfolge | Ende (UTC) | Originallog SHA-256 |
| --- | --- | --- |
| `direct-mcp-native-copy-owner-postgres-test` | `2026-10-18T19:42:31.909Z` | `2d6a345432efbb9874f21242e2c183bd392750056debb4852c92c96844a87299` |
| `workspace-operation-native-copy-owner-postgres-test` | `2026-10-18T19:53:52.419Z` | `1ebd6e0a9a1b0da709b0b59b9464fe6418353d7c8cba8ffaeddb0f825a326635` |
| `workspace-operation-native-copy-metadata-owner-postgres-test` | `2026-10-18T19:55:49.096Z` | `c71a4b6b058e39507cecfb732e3b0025a91baac957ea21c3620b26a4b78c8ddf` |

Der spätere ursprüngliche PTY-Beobachtungshandle war nicht mehr verfügbar. Die drei bereits geschriebenen Originalberichte, ihre Logs und `managed-after.json` bestätigen jedoch die tatsächlich abgeschlossenen Folgen; sie wurden deshalb weder neu gestartet noch aus einem fehlenden Handle als laufend oder fehlgeschlagen bewertet.

Die frische begrenzte RR-/READ-ONLY-Ressourcenprüfung am `2026-10-19T03:40:27.679Z` endet mit Exit 0. Sie bestätigt alle drei Originalberichte und Quell-/Loghashes, vor und nach den Tests null passende eigene Schemas/Backends, drei tatsächlich geloggte eigene DATA-Verzeichnisse und sechs bekannte Runner-/Fixture-PIDs abwesend. Die Prüfverbindung hat keine zugewiesene XID und wird geschlossen. Vier verwaltete Dienste behalten ihre IDs und gesunden Zustand, drei Health-URLs liefern HTTP 200. `resources-after.json` hat SHA-256 `8aa6b96c56b818018a8fa048063d9b757cb062ba57dc47f576d68b3e24088f5f`. Dies ist eine Abschlussbeobachtung, keine Vollhistorie unbeobachteter Prozesse. Es wurden keine Container gebaut oder verändert.

Der eingefrorene Hauptplansuffix sowie der bestehende dreiteilige Root-/QA-Unterschied für Aktivierung und frühere Belegtexte bleiben unverändert. Ein erfolgreicher frischer Main-Abruf bestätigt Notebook-main `67c509c08a204b7481fa063cf5de007de8538dd4` bereits als Vorfahren; Marketplace-main und sauberer lokaler Head stehen auf `54ce6573502f67f4cb6227871000aa315ab87dbe`. Dies ist keine erneute Abnahme des noch nicht integrierten Standard-Skills.

## Weiterer öffentlicher Anschluss

Als Nächstes sind der feste MCP-Dienst samt tatsächlicher Ansichtsfinalisierung, der strikte begrenzte Wirevertrag, registrierte Preview/Apply/Status/Recover-Aktionen und SDK-Methoden anzuschließen und tatsächlich zu prüfen. Ein zusätzlich erkanntes Budgetproblem gehört vor dessen Freigabe geschlossen: Ein 64-KiB-Wirekörper garantiert kein 64-KiB-Journal einschließlich echter Origin und endgültiger Kollisionsnamen. Preview und Apply müssen den vollständigen kanonischen Request nach Planauflösung vor erster physischer Vorbereitung/Stage auf das tatsächliche Journalbudget begrenzen.

Dieser Schritt bietet noch kein öffentliches Tool an und ist kein neuer Produktionsbuild, Browser-/OAuth-, SDK-, allgemeiner Aktivierungs-, Veröffentlichungs- oder Gesamt-E2E-Nachweis. Dateiaktions-Undo und experimentelles Review Center bleiben ausgeschaltet. Das vollständige Ziel einschließlich Move/Delete, SDK/Skill, Import/PDF, Suche, Sandbox und abschließender kombinierter E2E bleibt aktiv.
