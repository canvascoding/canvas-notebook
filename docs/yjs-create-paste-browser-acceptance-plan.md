# I-07: Gemeinsame Browserabnahme nach Create und Einzeldateiimport

Stand: 15.10.2026. **Testquellen vorbereitet; noch kein neuer Build- oder Browserpass.** Voraussetzung ist der abgeschlossene Notebook-I-06-Commit `8ffdbd6879c7a5d48061a936d278d19a76e82338`. Der [Create-/Paste-/Importplan](./markdown-create-paste-full-import-integration-plan.md) und dessen getrennte Aktivierungsgates bleiben maßgeblich.

## Sichtbare Benutzerwege

1. Auf Home oder im Dateibrowser eine neue Markdown-Datei anlegen, bei Bedarf zuvor zwei verschachtelte Zielordner über den echten Picker erstellen. Erst ein passender serverseitiger Abschluss öffnet den editierbaren Inhalt. Erster gewöhnlicher Clipboardpaste erhält die vorhandenen Absatz-/Inline-/Wiki-/Mention-/URL-Regeln; Markdownüberschriften und Listen werden dadurch nicht automatisch vollständig importiert.
2. Für bewusst strukturierten Markdown-Text im geöffneten Dokument die vorhandene Aktion „Markdown einfügen“ verwenden. Übernahme ist ein eigener Undo-Schritt; Abbruch erhält Inhalt und native Sequenz. Eine vollständige Datei mit Frontmatter gehört in den Dateiimport.
3. Eine einzelne ursprüngliche `.md`-/`.markdown`-Datei über den tatsächlichen Chunkimport auswählen. Rich und Plain-Fallback werden getrennt geöffnet. Die Abnahme liest wirkliche Downloadbytes und prüft BOM, CRLF und Frontmatter vor/nach Bearbeitung, Undo und Reload.
4. Geht nach tatsächlichem serverseitigem Createabschluss die Antwort verloren, bleibt der Dialog unbestätigt. Schließen, Reload, sichtbare Wiederherstellung des Pendingeintrags und erneutes Öffnen senden keinen Create. Erst „Erstellung erneut prüfen“ sendet denselben UUID-/Workspace-/Pfadauftrag und öffnet nach bestätigtem Ergebnis.

## Vorbereitete Matrix

| Spec | Vorgesehene Fälle und enger Zweck |
| --- | --- |
| `editor-create-paste-import.spec.ts` | 13: sechs bestehende Kernfälle unverändert; vier Kombinationen aus Home/Dateibrowser und Desktop/mobilem Web mit verschachteltem Create und erstem gewöhnlichem Markdownpaste; ein gültiger Insertionabbruch; zwei kleine originale BOM-/CRLF-Importprofile. |
| `editor-manual-create-recovery.spec.ts` | 2: Home und Dateibrowser, echter Server-POST per `route.fetch`, strikt bestätigter Abschluss, ausschließlich Antwortabgang verworfen, Reload und ausdrücklich gleicher Retry. Keine gefälschte Erfolgsantwort oder native Persistenzattrappe. |
| `editor-focus-width.spec.ts` | 1: bestehende Focus-/Breiten-/Panel-/Undo-/Tabellen-/Mobil-DOM-Prüfungen. Dokumentvorbereitung jetzt per wirklicher Markdown-Insertion. |
| `editor-markdown-insertion.spec.ts` | 3: bestehende strukturierte Insertion, Auswahl-/Fehlergrenzen, Peer/Undo/Reload und mobiles Web. Direkte Create-Fixtures verwenden feste UUID und strikte Completion. |
| `editor-rich-workspace-links.spec.ts` | 1: vorhandene scoped Link-/Fragment-/Klick-/Tastaturprüfungen und Byteerhaltung. Exakter Zielname `A\|B.md` wird über JSON-Create und echte Insertion vorbereitet; Multipart würde den Namen verändern. |
| `editor-yjs-owned-restart.spec.ts` | 2: bestehende tatsächliche graceful/crash Hostneustarts; Supervisor bleibt unverändert. |
| `destination-folder-creation.spec.ts` | 13 bei vollständiger Auswahl: vorhandene Desktop-/Mobile-Picker-, Create-/Upload-/Move-/Copyfälle. Die vier betroffenen UI-Dateianlagen prüfen jetzt strikten Completedabschluss. Die übrigen Fälle sind bestehende Regression, kein Nachweis einer allgemeinen Aktivierung der neuen Dateiaktionsverträge. |

Damit sind bei vollständiger Auswahl **35 Fälle vorgesehen**. Verbindlich sind später die tatsächlich entdeckten, gestarteten, bestandenen, fehlgeschlagenen und übersprungenen Fälle. Vorbereitung oder Sourceprüfung ist kein Browserpass. Die zusätzliche Recovery-Spec muss ausdrücklich ausgewählt werden; die bisherigen Supervisor-Defaults werden nicht erweitert.

## Fixture- und Buildvertrag

Der neue gemeinsame Testhelper erzeugt genau eine UUID, wartet vor dem Senden auf das bestehende Createbudget und führt genau einen POST aus. Ein unabhängiger Testassert verlangt HTTP 200 und das vollständige exakt passende `success/completion`-Envelope. Er verwendet nicht den Produktparser als eigenen Erwartungswert und versteckt keine Mutation hinter Retryschleifen.

Focus und der Literal-Pipe-Linktest verwenden keine nachträgliche native Whole-file-PUT-Befüllung. Die bestehenden Assertions nach ihrer Vorbereitung bleiben unverändert. Der alte Multipart-Testhelper bleibt bytegleich und separat; sein Erfolg wird nicht als neuer nativer Chunkimport dargestellt.

Die sieben Test-/Helperdateien werden im Integrationsworktree nach vollständigem TypeScript, Lint und Änderungsanalyse gemeinsam committet. Erst danach wird der bereits auf diese Aufgabe registrierte, saubere QA-Worktree `yjs-compiled-admission` wiederverwendet. Ein eigener QA-Branch aktiviert ausschließlich das vorhandene Gate für diesen privaten Build. Das Produktgate im Integrationsworktree bleibt `false`.

Build und Lauf verwenden die unveränderten Ownership-, Source-/Artefaktfingerprint-, Deadline-, Prozessgruppen-, Datenbank- und Cleanupprüfungen des vorhandenen Supervisors. Der tatsächliche npm-Produktionsbuild wird vor Runtimebeginn versiegelt. Die bestehenden vier verwalteten Container bleiben die gemeinsame Grundlage; es werden keine Container gebaut oder gestartet und keine zweite Umgebung installiert. Eigene bestätigte Notebook-/Issuer-Datenbanken, eigene DATA und ein Loopbackhost dienen ausschließlich diesem einen QA-Lauf.

Ein fehlgeschlagener Lauf bleibt mit seinem ursprünglichen Exitstatus und privaten Artefakten erhalten. Korrigierte Test-/Produktbytes benötigen vor einem weiteren Lauf ihren passenden Commit und Buildnachweis. Guards, Fingerprints und echte Auth-/Persistenzprüfungen werden nicht gelockert, damit ein Test besteht.

## Bisher tatsächlich geprüft

- Root: vollständiges cachefreies TypeScript mit 12 GiB, Exit 0; scoped ESLint aller sieben geänderten/neuen Test-/Helperdateien, Exit 0.
- Root: exakte eingefrorene Bytes aller sieben Dateien sowie tatsächliche Änderungen gelesen; unabhängige Source-Nachlese der neuen Browserfälle ohne konkreten P1/P2-Befund. Kein Runtimeurteil daraus.
- Root: frischer vollständiger GitNexus-Index und staged Analyse, acht Test-/Dokumentationsdateien, 26 Symbole, kein indexierter betroffener Prozess, LOW. Der getrennte Gesamtbranchvergleich gegen `main` bleibt mit 452 indexierten Dateien und 46 Prozessen CRITICAL; das ist kein alleiniger I-07-Umfang. Die zuerst fehlgeschlagene inkrementelle Indexierung (`LOWER: Invalid UTF-8`) bleibt als Toolfehlerbeleg erhalten; vollständiger Neuaufbau endet mit Exit 0, ohne Test- oder Produktänderung.
- Root: tatsächliche reine Importvorbereitung auf den unveränderten Produktbytes, Exit 0. Das 48-Byte-Frontmatterprofil wird `tiptap_blocks`, das 52-Byte-HTML-/Tabprofil `plain_text` mit `roundtrip_changed`; beide haben BOM und CRLF. Das belegt keine Auth-, PostgreSQL-, Editor- oder Browserausführung.

Native-Files-Createadapter und echte Native-Geräte bleiben getrennte Abnahmen. Ebenso bleiben die ursprüngliche Produktionsdatei, weitere Importflächen, initialisierte/aktive Vollimportziele und allgemeine Aktivierung offen. Ein Browserpass dieses engen Pakets schließt nicht den gesamten Architekturplan.

Private Rootbelege: `/var/folders/bx/tjzzmjhn2qdcdyfc_l7hkv900000gn/T/canvas-i07-root-integration-89vcr075/`.
