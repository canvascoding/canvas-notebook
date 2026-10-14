# Neustartabnahme: Absatz trotz Caretdekoration auswählen

Stand: 2026-10-14. Der geschlossene Lauf V14 prüft exakt `6007e1adfc0a33a4e83e6db4dc8a7225cde18841`. Die nachfolgende Korrektur betrifft ausschließlich die Testauswahl; die tatsächliche Persistenz- und Neustartabnahme bleibt offen.

## Tatsächlicher Browserlauf

Der erste unveränderte Produktionsbuild einschließlich aller drei Prebuild-Schritte und CLI-Versionseinfügung besteht. Root bestätigt vor START den echten vollständigen Build-/Sourcesiegelvertrag, den vollständigen privaten Loghash und nach Abschluss alle 33 bekannten Build-PIDs samt Observer sowie drei leere Prozessgruppen. Quellfingerprint `f0d012d72ee83d3434addf01bc0159d5731ce35fe20678a313007c81a7522e8b`, Buildfingerprint `c625faa7ffc32cbf18517e85d4d84001c81104f3922a2c87220a1b084555bb97`. Die vier ausgewählten Suites und ihre Daten, Assertions und Zeitlimits bleiben auf diesem Stand bytegleich `6cee66086b4d6044742fea143a6b5dcd5844e467`.

Ergebnis: **zehn tatsächlich gestartet, acht bestanden, zwei fehlgeschlagen**. Create-/Paste-/Import-Suite: sechs bestanden; Fokus/Breite: einer bestanden; vollständige Rich-Link-/Fragmentnavigation: einer bestanden. Kein Skip, Testtimeout oder Abbruch, keine automatische Wiederholung. Das bestätigt den [Rich-Fragmentfix](./yjs-rich-heading-navigation-evidence.md) erstmals im vollständigen ursprünglichen Linkfall. Es ist kein vollständiger Zehn-Fälle-Pass.

Beide Fälle in [editor-yjs-owned-restart.spec.ts](../tests/editor-yjs-owned-restart.spec.ts), ursprünglich Zeile 81, scheitern identisch am Klick auf `getByText('Peer paragraph.', { exact: true })` innerhalb des Peereditors. Die erste Eingabe, Peer-Bearbeitbarkeit und tatsächlichen JSON-Gleichheitsprüfungen an Zeile 80 sind zuvor durchlaufen. Die eigene Mutation des Peers, SQL-Durabilityprüfung und Hostneustarts werden nicht erreicht: `restartCount=0`. Ein 15-Sekunden-Locator-Timeout ist von einem Testtimeout zu unterscheiden.

## Unabhängige Diagnose

Root und zwei separate Read-only-Prüfungen gleichen beide erhaltenen Traces gegen ihre exakten SHA256/Dateigrößen ab. Die komprimierten Peer-DOM-Snapshots werden gemäß der installierten Playwright-Implementierung über ihre tatsächlichen relativen Postorder-Referenzen rekonstruiert. Vor und nach beiden fehlgeschlagenen Klicks zeigt sich derselbe Befund:

- Ein editierbarer ProseMirror-Editor mit zwei getrennten normalen `p[data-id]`.
- Der Zielabsatz hat genau den erwarteten Autorentext und eine stabile native ID.
- Ein nicht editierbares `collaboration-carets__caret`-Widget enthält zusätzlich eine mit `aria-hidden` markierte Cursorbeschriftung.
- Der vollständige DOM-Text umfasst deshalb 33 statt 15 Zeichen. Kein Element im Editor erfüllt den strikten vollständigen Textmatcher.
- Kein aufgelöstes Klickziel, kein Mehrfachtreffer und keine Pointer-Interception; tatsächlich nur Warten auf den Locator bis zum Actiontimeout.

Der installierte `internal:text`-Matcher schließt diesen zusätzlichen DOM-Text nicht aufgrund von `aria-hidden` aus. Die [Caretimplementierung](../app/lib/collaboration/block-tree-carets.ts) fügt das Widget als Dekoration ein; das [Rendering](../app/components/editor/MarkdownEditor.tsx) schreibt die Cursorbeschriftung als DOM-Text. Das ist kein Beleg für verlorene Absätze oder einen Fehler nach Neustart.

Die erfolgreichen JSON-Gleichheitsprüfungen sind tatsächlich aufgezeichnet. Ihre vollständigen Rückgabewerte sind in diesen Traces nicht serialisiert; aus dem DOM wird keine vollständige native JSON-Snapshotdatei erfunden.

## Enge Testkorrektur und Abnahme

Die [Create-/Paste-Suite](../tests/editor-create-paste-import.spec.ts), ursprünglich Zeilen 81–94, besitzt bereits die passende Strategie: exakten nativen Absatzinhalt prüfen, dessen gültige stabile ID bestimmen und anschließend das reale `p[data-id]` anklicken. Dieser Vertrag ist jetzt in den [gemeinsamen Testhelper](../tests/helpers/native-rich-paragraph.ts) ausgelagert und wird für beide Suites verwendet. Der native Textvergleich bleibt exakt; Sichtbarkeit, tatsächlicher Klick, Tastatureingabe und alle späteren Persistenz-/Restartassertions bleiben Pflicht. Es gibt keinen Substring-Fallback für den nativen Inhalt, keinen erzwungenen Klick, keine DOM-Manipulation und keine Lockerung von Seeds, Zeitlimits oder Skipregeln.

Root bestätigt bytegleiche Integration der drei Testdateien und vollständige Gleichheit des Helper-Prüfkerns nach Inlining des tatsächlichen bisherigen `tree()`-Ausdrucks. Die gesamte Create-/Paste-Describe-Suite und damit ihre sechs Caseblöcke bleiben bytegleich. Die Restartdatei bleibt nach Rücknahme genau des neuen Imports und des gezielten Locatorersatzes vollständig bytegleich. Fokus-/Links-Suites, Runner und QA-Konfiguration bleiben unverändert. Full TypeScript mit 8 GiB Heap, scoped ESLint und unabhängige Source-Review bestehen. Präzise Pre-Edit-Impacts für den bisherigen Helper und die Restartdatei sind LOW; anonyme Testcallbacks sind nicht separat im Graph erfasst, weshalb die konkrete Sourceprüfung die indexierte Analyse ergänzt.

Die weitere echte Browserabnahme muss beide Neustartphasen erreichen und erfolgreich abschließen; die bisherige Acht-Pass-Auswahl ersetzt sie nicht. Die erneute vollständige Browserabnahme der Testkorrektur steht aus. Produktdateien, Package und Dokumentinhalte bleiben unverändert.

Root bestätigt nach Laufende unabhängig alle sieben bekannten Runtime-PIDs und sieben leere Gruppen, freien Port und entfernten Lock sowie erhaltene Root-/DATA-Identität und beide exakten eigenen PG18-Datenbank-OIDs mit Owner/Marker und null Sessions. Der passive QA-Observer erfasst alle vier Browser-CLI-PIDs direkt; Root beobachtet während des Laufs selbst nur den Restart-CLI und weist diese Grenze aus. Daten und private Belege bleiben erhalten. Root bestätigt anschließend erneut den echten unveränderten Build-/Sourcesiegelvertrag. Vorhandene Dienste und Container bleiben unverändert.

Private Tracebelege: graceful 15.591.957 Bytes, SHA256 `8e75fa0e0d32737fca37f31be418c2504e5375ea36f8f5775b29a01caef16a95`; crash 16.023.670 Bytes, SHA256 `7f41057066b7b41b1b16b4b0bb2d16b21631034c8d9f2ac6b191e36da812f71a`. Strukturierter Offlinebericht 12.921 Bytes, SHA256 `2035bfb8a63be12065e1403afd876f957ef1e95777df6fd9d179c82d212bba40`. Dateien 0600 unter eigenen 0700-Verzeichnissen; keine Rawframes, Header, Credentials, Cursorbenennungen oder Markerpayloads in öffentlichen Nachweisen.
