# V11 und macOS-Strg-Linknavigation

## Geschlossener Browserlauf

V11 prüfte den eingefrorenen Stand `6cee66086b4d6044742fea143a6b5dcd5844e467` mit neuem Produktionsbuild im eigenen Worktree. Source-Digest: `c35f320a82a1d3cab02f7fd3e7677b9ed6b5ec3a8479aa907dffd0393536d081`; Build-Digest: `cde81e0a267c1d4128beeb549721cd200f21d49a7eae2d5dde03f6bc8ef9f098`. Der erfolgreiche Build und seine drei vorhandenen Prebuild-Schritte wurden vor dem Start und nach Laufende separat bestätigt.

Die sechs ursprünglichen Create-/Paste-/Importfälle und der ursprüngliche Fokus-/Breitenfall bestehen erneut. Der Linkfall scheitert bei der ersten Strg-Linksklick-Assertion in Zeile 81: Erwartet wird `A|B.md`, angezeigt bleibt `Start.md`. Acht Fälle wurden gestartet, sieben bestehen, einer scheitert; die zwei Neustartfälle wurden nicht gestartet. Keine Skips, Testtimeouts oder Unterbrechungen. Runner Exit 1; kein vollständiger Zehn-Fälle-Pass.

Die [exakte Zielvorbereitung](./yjs-rich-links-fixture-evidence.md) funktioniert diesmal: JSON-Create, revisionierter Dokument-Read/-Write und echter Datei-Read bestätigen vor der Browserinteraktion den tatsächlichen Pfad und Inhalt. Beide tatsächlichen Linkindex-Antworten enthalten das Pipe-Ziel und lösen den Internal-Link auf genau einen Kandidaten auf. Nach dem Strg-Klick findet kein Ziel-Datei-Read statt. Der Ausgangseditor bleibt im Assertionssnapshot vorhanden und editierbar. Der Trace zeichnet die native DOM-Ereignisart nicht auf; aus ihm allein folgt keine Aussage, ob `click` oder `contextmenu` ausgelöst wurde.

Root bestätigt nach Laufende unabhängig erhaltene Root-/DATA-Identitäten, sechs abwesende eigene PIDs, fünf leere eigene Prozessgruppen, freien Port und entfernten Runtime-Lock. Die beiden exakten erhaltenen PG18-Datenbank-OIDs stimmen mit den Eigentumsmarkern überein und haben null Sitzungen. Root bestätigt erneut das gleiche Source-/Build-Siegel. Private Traces, Header, Bodies und Anmeldedaten bleiben privat. Fremde Dienste und Container wurden nicht verändert.

## Separater tatsächlicher Ereignisnachweis

Ein unabhängig geschlossener lokaler Chromium-Probeversuch verwendete einen bekannten Anker ohne Seitenanfragen. Plattform: macOS 26.6.1, arm64; Playwright 1.61.1; Chromium 149.0.7827.55. Jeweils Headless und sichtbar wurden Strg-Linksklick, Cmd-Linksklick, gewöhnlicher Linksklick und Rechtsklick geprüft, jeweils mit und ohne `contextmenu.preventDefault()`; insgesamt 16 vertrauenswürdige Eingaben.

Strg-Linksklick erzeugt `contextmenu` mit `button: 0` und `ctrlKey: true`, anschließend keinen `click`. Cmd- und gewöhnlicher Linksklick erzeugen `click`. Rechtsklick erzeugt `contextmenu` mit `button: 2` und `auxclick`. Beide Browsergruppen sind beendet; keine Netzwerkrequests. Root liest das private Ereignisprotokoll unabhängig und bestätigt dessen Digest `ca056cd7beb81190bcd24903b38aa5d938b7a33642f8bf0d24868da4bb38bb80`.

Der bisherige [Editorhandler](../app/components/editor/MarkdownEditor.tsx) lauscht ausschließlich auf `click`. Damit erreicht der belegte macOS-Strg-Linksklick diesen Handler nicht. Die bestehende Komponentenprüfung erzeugte für Strg hingegen künstlich ein `click` und konnte diese Plattformlücke nicht erkennen. Der eigenständige Ereignisnachweis und die V11-Anwendungsabnahme bleiben unterschiedliche Belege.

## Enger Fix und lokale Regression

Derselbe Capture-Handler lauscht zusätzlich auf `contextmenu`. Für diesen Ereignistyp akzeptiert er ausschließlich `ctrlKey: true` und `button: 0`; alle anderen Kontextmenüs durchlaufen den bisherigen Browser-/Editorpfad. Die existierenden Anker-, Workspace-, Gast-, Rechte-, Protokoll- und Externalprüfungen in `openDocumentLink` bleiben unverändert. Beide Listener werden bei Cleanup entfernt. Es gibt keine Plattformkennung, neue Navigation oder Änderung an Resolver, Store, Auth oder APIs.

Die erweiterte [reale React-/Rich-Editor-Komponentenprüfung](../scripts/rich-editor-link-ui-test.tsx) bestätigt genau eine geschützte Navigation für diesen Kontextmenüfall, unveränderte Writer- und Reader-Kontextmenüs, Gastblockade, sichere externe Protokolle und Unsafe-URI-Abweisung. Inhalt, Änderungs-Callback und Undo-Historie bleiben unverändert; Unmount entfernt auch den Kontextmenülistener. Sie verwendet weiterhin JSDOM-Geometrie und simulierte Navigation und ersetzt keine Browser-/Serverabnahme.

Root bestätigt die bestehende Navigation-Clientprüfung, vollständiges TypeScript mit 8 GiB und fokussiertes ESLint. Die vier bestehenden Browser-Suites bleiben bytegleich zum eingefrorenen V11-Stand. Die präzisen Pre-Edit-Impacts sind LOW: Handler ohne externe Caller; bestehende Open-Funktion zwei direkte/fünf insgesamt erfasste Caller, ein indizierter Ablauf; Komponentenfixture ein direkter Caller, keine Abläufe. Die Open-Funktion wird nicht verändert.

Andere Browser sowie Strg-modifizierte Tastaturmenüs sind durch den nativen Probeversuch nicht geprüft. Ein neuer frischer Build und der unveränderte ursprüngliche Browserlauf müssen den tatsächlichen Anwendungsfix noch bestätigen. Der V11-Fehlschlag wird nicht rückwirkend zu einem Erfolg. Native Session-/Writer-/Dateioperations-Aktivierung und Produktionsreparatur bleiben separate offene Gates.
