# I-07: Gemeinsame Browserabnahme nach Create und Einzeldateiimport

Stand: 15.10.2026. **Ein frischer Build bestanden; erster Browserlauf fehlgeschlagen, Korrekturabnahme offen.** Voraussetzung ist der abgeschlossene Notebook-I-06-Commit `8ffdbd6879c7a5d48061a936d278d19a76e82338`. Der [Create-/Paste-/Importplan](./markdown-create-paste-full-import-integration-plan.md) und dessen getrennte Aktivierungsgates bleiben maßgeblich.

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

## Erster tatsächlicher Buildanlauf

Der eigene QA-Branch `codex/yjs-create-paste-qa` basiert auf dem committeten Teststand `01d394679d1b012c0688e146838e79d047f84982`. Commit `9bffc868b69bf4b8c7cc94770d1b2bb7fba3b106` ändert ausschließlich die vorhandene Gatekonstante für diesen privaten Build. Der Integrationsworktree behält das geschlossene Produktgate.

Der unveränderte Supervisor beendet den ersten frischen npm-Produktionsbuild mit Exit 1: Die Anwendung kompiliert; das anschließende TypeScript mit `tsconfig.release.json` weist `new Headers(original.headers.map(pair => [...pair]))` in `authenticated-native-session-transport.ts:162` als `string[][]` zurück. Der zuvor bestandene Gesamt-TypeScriptlauf ist dadurch kein bestandener Release-Typecheck. Es wurde kein neuer Buildbeleg versiegelt und kein Browser-/Anwendungshost gestartet. Die 63 ausgegebenen Turbopackwarnungen sind vom konkreten Typfehler getrennt.

Die enge Korrektur deklariert jede bereits aus einem geprüften Tupel kopierte Headerzeile ausdrücklich als `[string, string]`. Root vergleicht den transpilierten JavaScripttext der gesamten Datei vor/nach der Korrektur: bytegleich. Die erste Vergleichsfassung mit einer Callback-Rückgabetypannotation änderte lediglich ausgegebene Klammern und bestand den strengen Bytevergleich nicht; erst die tatsächlich verwendete Tupelassertion besteht ihn. Vor dem Codeeingriff zeigt GitNexus vier direkte Aufrufer und 13 insgesamt betroffene Symbole, LOW; keine indexierte Prozesszuordnung ersetzt die spätere Laufzeitprüfung. Der vollständige cachefreie Release-Typecheck mit 12 GiB endet tatsächlich mit Exit 0, ebenso scoped ESLint. Die staged Analyse ordnet nur den vorhandenen umschließenden Runtime-Erzeuger und `freshRequest` zu, zwei Dateien einschließlich dieses Dokuments, kein indexierter Prozess, LOW. Der getrennte Gesamtbranchvergleich bleibt CRITICAL und ist keine Abnahme dieses Gesamtumfangs. Der erneute frische Build folgt auf den Korrekturcommit.

## Versiegelter Build und erster Browserlauf

Der zweite frische npm-Build auf QA `5a0df13a482042d50c620dd70f5f1be0f5eaf077` endet mit Exit 0. Root bestätigt den vorhandenen Buildprüfer unabhängig vor und nach dem Browserlauf, jeweils Exit 0: Sourcefingerprint `cc596a29e1cf2346bd5d9959388b81214654164331856a58e95a32a9581f4453`, Artefaktfingerprint `8fc20c85339186b23ebc4320e1840b87ce8f59f1dc0151958b72979a4078dfe9`. Die Build-ID allein ist kein eindeutiger Standnachweis.

Der ursprüngliche Supervisor startet tatsächlich die erste ausgewählte Spec. Ihr Reporter meldet 13 entdeckte Fälle, 1 bestanden, 12 fehlgeschlagen, keine übersprungenen, unterbrochenen oder zeitlich abgebrochenen Fälle. Der Supervisor endet mit Exit 1 und startet die übrigen sechs Specs nicht; es gab keinen Hostneustart. Das ist keine bestandene Create-/Paste-/Importmatrix.

Alle neun in den Fehlerspuren aufgezeichneten Markdown-Create-POSTs enthalten eine gültige UUID. Trotzdem antwortet der Server mit HTTP 400 und `MARKDOWN_CREATE_REQUEST_ID_REQUIRED`. Dieser Fehlerzweig prüft neben der UUID auch `request instanceof NextRequest`; JSON-Lesen und Weiterleitung lassen die ID unverändert. Die tatsächliche kompilierte Prüfung weist somit den HTTP-Request bei dieser Instanzprüfung ab. Der genaue Unterschied der Konstruktor-/Proxyherkunft wurde nicht zusätzlich instrumentiert. Drei weitere Fehler betreffen den Uploadpfad; sie werden nicht als fehlgeschlagene Manual-Create-Aufrufe gezählt. Der vollständige Markdown-Import liefert dort unter anderem `MARKDOWN_UPLOAD_REQUEST_CONFLICT` aus dem eigenen Instanz-/Singlefile-Guard.

Die vorhandenen Web-/Mobile-Sessionrouten lösen diese Grenze bereits durch eine synchrone lokale `NextRequest`-Kopie vor dem ersten Await. Derselbe enge Anschluss wird für Create, Web- und Mobile-Chunk-Abschluss sowie Uploadstatus-GET verwendet. Authentisierung und nachfolgender nativer Service erhalten dieselbe Kopie von URL, Methode und Headers; Bodyverarbeitung und Ratelimit lesen weiterhin den tatsächlichen Request. Die nativen Instanz-/Principal-/Rechte-/Scope-/Abschlussprüfungen bleiben erhalten. Mobile-Create und Mobile-Uploadstatus erben die entsprechenden Webhandler. PUT-/DELETE-Uploadwege und generische Schreibcallbacks werden nicht umgebaut.

Vor jeder Handleränderung liegen exakte Symbolimpacts vor, jeweils LOW und null indexierte direkte Aufrufer. Die zusätzliche API-Routenanalyse findet weder über URL noch Dateipfad einen Routeneintrag; das wird als Indexlücke behandelt, nicht als Beweis fehlender HTTP-Verbraucher. Die bekannten Web-/Mobile-Create-, Upload- und Statuscaller wurden im Source nachgelesen. Zwei echte Manual-PG18-Familien (`scope`, `raw`) und die echte Chunkfamilie `gate-disabled-completed` bestehen nach dem Anschluss. Zwei vorherige zusätzliche Chunkanläufe bleiben als Testvoraussetzungsfehler erhalten: zuerst fehlte der Native-Sourcepfad, danach verweigerte die unveränderte Prüfung den noch uncommitteten Checkout statt der ausdrücklich gepinnten sauberen Originalbasis `acfa5061`. Dieser Originalconsumer wird hier nicht als erneut bestanden gemeldet; die Schutzprüfung wird nicht gelockert.

Die eigenen Host-/Issuer-/Supervisorprozesse des Browseranlaufs sind beendet, der Runlock ist freigegeben und Root beobachtet unabhängig null Verbindungen zu beiden eigenen Datenbanken. Wegen des fehlgeschlagenen Laufs bleiben Datenbanken, DATA und private Fehlerspuren gemäß unverändertem Supervisor erhalten. Es wird keine erfolgreiche Datenbereinigung behauptet. Erneute Browserabnahme verlangt den passenden Korrekturcommit und einen neuen versiegelten Build.

Für die vier HTTP-Anschlüsse bestehen danach der vollständige cachefreie Release-Typecheck und scoped ESLint, jeweils Exit 0. Ein AST-/Bytevergleich bestätigt unveränderte Commitcallbacks, Upload-PUT-/DELETE-Bodies und die vollständigen Principal-, Manual-/Chunkkoordinator- und Uploadservicequellen. Die staged Analyse erfasst fünf Dateien, sechs Symbole und acht Prozesse, HIGH: die erwarteten vorhandenen Auth-, Benutzer-, Rechte-, Deployment- und Rate-Limit-Wege. Deren Implementierungen werden nicht verändert. Der getrennte Gesamtvergleich gegen `main` bleibt mit 452 indexierten Dateien, 4.997 Symbolen und 46 Prozessen CRITICAL; daraus folgt keine Freigabe des Gesamtbranches.
