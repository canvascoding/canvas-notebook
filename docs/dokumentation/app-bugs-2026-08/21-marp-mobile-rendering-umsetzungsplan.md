---
title: 'Umsetzungsplan zu Ticket 21: MARP-Praesentationen auf Mobile korrekt rendern'
status: implemented-pending-device-acceptance
date: 2026-08-21
ticket: ./21-marp-mobile-rendering-korrigieren.md
repositories: [canvasstudios-notebook, canvas-notebook-mobile]
---

# Umsetzungsplan zu Ticket 21: MARP-Praesentationen auf Mobile korrekt rendern

## 1. Auftrag, Scope und Abgrenzung

Dieser Plan konkretisiert ausschliesslich [Ticket 21](./21-marp-mobile-rendering-korrigieren.md).
Er plant einen sicheren, versionierten Read-only-Preview-Pfad fuer gespeicherte Marp-Dateien in der
Expo-App und die visuelle Paritaetsabnahme mit der bestehenden Webvorschau.

Im Scope sind:

- ein kanonischer Notebook-Render-/Asset-Vertrag fuer Web, iOS und Android,
- gemeinsame, versionierte Reproduktions-Fixtures,
- Marp-Erkennung in der Mobile-Dateiliste,
- serverseitiges Rendering und ein mobiler API-Adapter,
- eine native Mobile-Buehne mit einer eingebetteten, isolierten WebView nur fuer das gerenderte Deck,
- Touch-Navigation, Fit/Zoom, Safe Areas und Rotation,
- Auth-, Workspace-, Asset-, Offline-, Lade- und Fehlerzustaende,
- automatisierte Vertrags-, Komponenten- und Sicherheitspruefungen sowie visuelle Paritaetsabnahme.

Nicht im Scope sind:

- Marp-Bearbeitung oder YAML-/Editor-Roundtrips; das bleibt Ticket 22,
- PDF-, PNG-, JPEG- oder PPTX-Export ausser als bestehende Regression,
- eine WebView-Huelle fuer die gesamte Canvas-App,
- allgemeine HTML-Preview-Haertung ausser dort, wo vorhandene Bausteine bewusst wiederverwendet werden,
- ein allgemeiner Offline-Dateispeicher oder eine Offline-Mutationsqueue,
- frei konfigurierbare Remote-Asset-Proxies oder neue Organization-Settings.

Das separate Repository `canvas-notebook-mobile` wurde nach gezielter Suche unter
`/Users/frankalexanderweber/Documents/canvas-notebook-mobile` gefunden und in einem eigenen,
detached Planungs-Worktree auf `origin/main` (`69e16e4`) vollstaendig nur lesend inventarisiert.
Die nachfolgend genannten Mobile-Dateipfade und Versionen sind deshalb am realen Mobile-Codebestand
belegt. Runtime-Verhalten auf Simulatoren und Geraeten bleibt dagegen bewusst Bestandteil der
Implementierungsabnahme.

## 2. Gelesene Grundlagen und aktueller Bestand

### 2.1 Verbindliche Architekturgrundlagen

- `docs/expo-mobile-app-plan.md` legt eine native Expo-App, den Server als Source of Truth,
  `/api/mobile/v1`, capability-gesteuerte Kompatibilitaet, expliziten Workspace-Kontext und nur
  begrenzten Lesecache fest. Eine WebView fuer einzelne kontrollierte Dokumenttypen widerspricht
  nicht dem Verbot einer WebView-Huelle fuer die gesamte App.
- `docs/architecture/canvas-notebook/plan.md` verweist auf die Team-Workspace-Regeln.
- `docs/architecture/canvas-notebook/team-workspace/03-scope-matrix.md` fordert, dass File-API und
  Previews workspace-aware bleiben und keine absoluten Serverpfade leaken.
- `app/lib/workspaces/request.ts`, `app/lib/workspaces/path-guard.ts` und
  `app/lib/filesystem/workspace-files.ts` bilden heute die serverseitige Auth-, Permission- und
  Pfadgrenze. `requireRequestWorkspace(..., { permissions: 'canRead' })` und
  `workspaceFileOptions(...)` muessen auch fuer Marp Mobile die Autoritaet bleiben.

### 2.2 Bestehender Marp-Pfad im Notebook

| Bereich | Heutiger Bestand | Relevanz fuer Ticket 21 |
| --- | --- | --- |
| Erkennung | `app/lib/marp/detect.ts` erkennt `.marp.md`, `.slides.md`, Front Matter und Marp-Kommentar. | Die Mobile-Dateiliste nutzt diese Erkennung noch nicht als eigenen Open-Kind. |
| Rendern | `app/lib/marp/render.ts` rendert mit `@marp-team/marp-core`, sanitisiert erlaubte HTML-Elemente, inlinet lokale Bilder/CSS-URLs bis 5 MiB und erzeugt ein komplettes HTML-Dokument. | Gute gemeinsame Basis, aber Ergebnis und Warnungen sind noch kein versionierter Mobile-Vertrag. |
| Webroute | `POST /api/files/marp-preview` erwartet `{ path, content }`, prueft `canRead`, Dateiexistenz, Typ und 5-MiB-Quelllimit und gibt HTML zurueck. | Der Webeditor darf ungespeicherten Inhalt vorschauen; Mobile soll dagegen den gespeicherten Serverstand laden. |
| Weboberflaeche | `app/components/editor/MarpPreview.tsx` laedt HTML und zeigt alle Folien vertikal in einem `iframe srcDoc`, Sandbox `allow-scripts`. | Kein nativer Slide-State, keine horizontale Touch-Navigation und kein mobiler Fehlervertrag. |
| Export | `marp-pdf`, `marp-images` und deren Mobile-Aliase lesen die gespeicherte Datei und verwenden den gemeinsamen Workspace-Kontext. | Bleibt unveraendert, dient aber als Auth-/Request-Praezedenz. |
| Public Preview | `app/lib/public-sharing/public-markdown-export.ts` und `/public/marp-preview/[token]` rendern oeffentliche Freigaben. | Darf nicht als Mobile-Auth-Umgehung wiederverwendet werden. |

Der Renderer erzwingt heute direkte Marp-Kinder (`.marpit > svg`). Der Commit
`ec2eb01d` entfernte nachweislich zusaetzliche `figure`-/`div`-Wrapper, weil diese die vom Marp-Theme
erzeugten direkten CSS-Selektoren und damit die Gestaltung brachen. Der Commit `ba8e3b29` ergaenzte
mobile Breiten-, Safe-Area- und Overflow-Regeln. Beide Regressionen muessen durch Fixtures und
Strukturtests dauerhaft gesichert werden; eine Mobile-Buehne darf die gerenderte Marp-DOM-Struktur
nicht erneut umschreiben.

### 2.3 Bestehender Mobile-Dateivertrag

- `app/lib/mobile/files.ts` klassifiziert jede Markdown-Datei als `openKind: 'markdown'` und liefert
  keinen `isMarp`- oder `renderKind`-Hinweis.
- `GET /api/mobile/v1/files/detail` liefert fuer kleine Markdown-Dateien den Textinhalt, aber keinen
  Marp-Rendervertrag.
- Unter `/api/mobile/v1/files/export/` existieren nur Aliase fuer Detect, PDF und Bilder. Es gibt
  keine Mobile-Marp-Preview-Route.
- `app/lib/mobile/compatibility.ts` und `app/lib/mobile/bootstrap.ts` melden `files.html_preview`,
  aber keine eigene Marp-Preview-Capability.
- Der HTML-Preview-Pfad verwendet kurzlebige Tickets, damit untrusted WebView-Inhalt keine Better-
  Auth-Session erhaelt. Marp kann sicherer und einfacher als selbstenthaltenes HTML ueber den
  authentifizierten nativen API-Client geladen werden, weil lokale Assets vor Rueckgabe auf dem
  Server aufgeloest werden. Daher ist fuer Marp kein oeffentlicher Asset-/Ticket-Pfad erforderlich.
- `packages/mobile-contracts` ist im aktuellen Repository trotz der Zielarchitektur aus
  `docs/expo-mobile-app-plan.md` noch nicht vorhanden. Ticket 21 soll nicht nebenbei die gesamte
  Contract-Paketmigration umsetzen; sein Vertrag wird in `app/lib/mobile/` kanonisch typisiert und
  als versioniertes Fixture-Artefakt fuer das Mobile-Repository exportierbar gemacht.

### 2.4 Bestehende Tests und Luecken

- `scripts/marp-preview-render-test.ts` prueft derzeit nur zwei Folien, direkte SVG-Kinder,
  Beschriftungen und das Fehlen der frueheren Wrapper.
- `scripts/mobile-files-test.ts` prueft Datei-Open-Kinds, HTML-Preview-Tickets und die drei
  Marp-Export-Aliase, aber weder Marp-Erkennung in File-Responses noch einen Preview-Vertrag.
- `scripts/mobile-compatibility-test.ts` und `scripts/mobile-bootstrap-test.ts` pruefen Capabilities
  als vollstaendige Arrays. Eine neue Capability muss an beiden Stellen bewusst ergaenzt werden.
- Die Marp-Renderpruefung hat aktuell keinen eigenen `package.json`-Testbefehl und wird von
  `scripts/test-all.mjs` nicht direkt ausgefuehrt.
- Es gibt keine gemeinsamen Marp-Fixtures, keine Route-/ACL-Tests, keine Asset-Isolationstests,
  keine Snapshot-/Screenshot-Baselines und keine iOS-/Android-Abnahme im vorliegenden Repository.

### 2.5 Tatsaechlicher Mobile-Codebestand auf `origin/main`

- Das Mobile-Repository verwendet Expo SDK `57.0.14`, React Native `0.86.2` und
  `react-native-webview` `13.16.1`. `react-native-gesture-handler` `2.32.0`, Reanimated `4.5.1`,
  Safe Area Context und `expo-network` sind bereits vorhanden; fuer Buehne, Gesten, Layout und
  Netzstatus ist voraussichtlich kein neues Native-Modul erforderlich.
- `app.config.ts` setzt `orientation: 'default'`. Die App unterstuetzt damit Portrait und Landscape,
  besitzt aber keine `expo-screen-orientation`-Abhaengigkeit. Bestehende responsive Screens verwenden
  `useWindowDimensions()`, `useSafeAreaInsets()` und `calculateResponsiveLayout()` aus
  `src/components/layout/responsive-layout.ts` beziehungsweise `responsive-layout-metrics.ts`.
- `src/features/files/contracts.ts` kennt Marp nur ueber Exportpfade; `CanvasFileEntry` hat weder
  `renderKind` noch einen Marp-Open-Kind. Die Runtime-Parser sind fail-closed und verwenden
  `INVALID_FILES_CONTRACT`, was fuer den neuen Vertrag beibehalten werden soll.
- `src/features/files/api.ts` implementiert `detectMarpFile()` ausschliesslich gegen
  `/api/mobile/v1/files/export/marp-detect`. Es gibt keinen Preview-Client.
- `src/features/files/files-browser-screen.tsx` ruft `detectMarpFile()` nur beim Oeffnen des
  Aktionsblatts auf, um PDF-/PNG-/JPEG-Exportaktionen einzublenden. `openItem()` navigiert vorher
  anhand von `openKind` und erkennt Marp nicht.
- `src/features/files/navigation.ts` leitet jedes Markdown-Dokument auf
  `/files/markdown/[documentPath]` beziehungsweise `/chat/file/markdown/[documentPath]`.
  `src/app/(app)/(tabs)/files/view.tsx` redirectet Markdown ebenfalls zwingend auf diese Route.
- Beide Markdown-Routen mounten `NotebookDocumentScreen`. Marp wird daher heute als normale native
  Markdown-/Notebook-Datei gelesen und bearbeitet, nicht als Praesentation gerendert. Ticket 21 muss
  einen separaten Read-only-Praesentationspfad einfuehren und die bestehende Markdown-Route nur als
  explizite `Markdown bearbeiten`-/Fallback-Aktion behalten; Editorsemantik bleibt Ticket 22.
- `src/features/files/html-viewer.tsx` und `html-webview.native.tsx` liefern einen nuetzlichen
  Security-Praezedenzfall: incognito/no-cache, keine geteilten oder Drittanbieter-Cookies, kein
  File-Access, `mixedContentMode="never"` und kontrollierte Navigation. Die aktuelle Komponente ist
  jedoch bewusst URI-/Ticket-basiert, laesst JavaScript/DOM-Storage und interne HTTPS-Navigation zu
  und darf fuer selbstenthaltenes Marp nicht durch Aufweichen ihrer HTML-Semantik wiederverwendet
  werden. Ticket 21 plant eine eigene kleinere `MarpWebView` mit lokaler HTML-Quelle.
- TanStack Query ist in `src/providers/app-providers.tsx` nur in-memory konfiguriert; es gibt keine
  persistierte Query-Cache-Schicht. File-Detail-Keys enthalten die aktive Workspace-ID. Auth-
  Instanzwechsel, Logout und Disconnect rufen in `src/features/auth/auth-provider.tsx`
  `queryClient.clear()` auf. Damit ist der geplante in-memory Offline-Zustand codebestandsnah und
  ein neuer persistenter Deckcache nicht erforderlich.
- `src/features/chat/realtime-provider.tsx` zeigt das vorhandene Muster fuer `expo-network`-Listener,
  App-State und Query-Invalidierung beim Reconnect. Der Marp-Screen kann dieses Muster in einer
  kleinen gemeinsamen Hook wiederverwenden, ohne Chat-State zu koppeln.
- `scripts/files-foundation-test.ts` prueft bereits File-Parser, Routing, Marp-Detect/Export und
  WebView-Sicherheitsflags. Der fokussierte Mobile-Testbefehl ist `npm run test:files`; das volle
  Mobile-Gate ist gemaess Mobile-`AGENTS.md` `npm run verify`.

## 3. Fehlerursachen: belegt und in Phase 0 zu verifizieren

| Status | Ursache/Hypothese | Beleg oder Verifikation |
| --- | --- | --- |
| Belegt | Mobile kann aus der File-Response nicht stabil erkennen, dass Markdown als Marp zu oeffnen ist. | `mobileFileOpenKind()` liefert fuer alle `.md`/`.markdown` nur `markdown`; ein Detect-Alias liegt separat unter `files/export`. |
| Belegt | Es fehlt ein versionierter Mobile-Preview-Endpunkt samt Capability und strukturierten Fehlern. | Unter `app/api/mobile/v1/files/` existiert keine Marp-Preview-Route; Compatibility/Bootstrap melden sie nicht. |
| Belegt | Der bestehende Web-HTML-Output ist eine vertikale Dokumentansicht, keine zustandsbehaftete mobile Praesentationsbuehne. | CSS in `render.ts` zeigt alle `.marpit > svg`; `MarpPreview.tsx` besitzt keinen aktiven Folienindex. |
| Belegt | Zusaetzliche Wrapper koennen Marp-Themes brechen. | Historische Korrektur `ec2eb01d` und heutiger Strukturtest. |
| Belegt | Lokale Assetfehler und das 5-MiB-Limit werden nur geloggt; der Client erhaelt keine maschinenlesbaren Warnungen. | `resolveWorkspaceAssetDataUri()` gibt `null` zurueck und laesst die urspruengliche URL stehen. |
| Belegt | Der aktuelle CSP erlaubt HTTP-/HTTPS-Bilder, Medien und Fonts; eine feste Remote-Asset-Policy fehlt. | CSP in `renderMarpMarkdownToHtmlDocument()`. |
| Belegt | Renderer- und API-Ergebnis enthalten keine Folienzahl, Seitengroesse, Source-Revision oder Contract-Version. | Aktuelle Rueckgabe ist nur ein HTML-String. |
| Belegt | Marp oeffnet aktuell den normalen `NotebookDocumentScreen`; Detect wird nur fuer Exportaktionen verwendet. | `files-browser-screen.tsx`, `navigation.ts`, die Files-/Chat-Markdown-Routen und `files-foundation-test.ts`. |
| Zu verifizieren | Plattformabweichungen von `react-native-webview` bei `foreignObject`, SVG-Text, Fonts, `viewBox`, Zoom und Rotation. | Gleiche Fixtures auf iOS-Simulator/Geraet und Android-Emulator/Geraet reproduzieren. |
| Teilweise belegt | Die App erlaubt beide Orientierungen und bestehende Layouts reagieren auf Window-Masse; ein Marp-Screen und damit dessen Remount-/Stateverhalten existiert noch nicht. | `app.config.ts`, `responsive-layout.ts`; final per neuem Komponenten-/Device-Test verifizieren. |
| Belegt | File-/Query-Inhalte werden nur in-memory gehalten und bei Auth-Identitaetswechsel/Logout/Disconnect geleert; Workspace-Queries sind per ID getrennt. | `app-providers.tsx`, `auth-provider.tsx`, `workspace-provider.tsx`, File-Query-Keys. |

Phase 0 darf Hypothesen nicht als bereits bewiesene Fehler behandeln. Sie endet mit einem kurzen
Reproduktionsprotokoll pro Plattform, einschliesslich App-/OS-/WebView-Version und Screenshot-ID.

## 4. Zielarchitektur und Sicherheitsentscheidungen

### 4.1 Kanonisches serverseitiges Rendering

Der Notebook-Server bleibt die einzige Marp-Engine. Die Expo-App nimmt weder `@marp-team/marp-core`
noch eine zweite Markdown-/Theme-Implementierung auf. Dadurch verwenden Web, iOS und Android exakt
dieselbe Marp-Version, Sanitizer-Regel, Asset-Aufloesung und Folien-DOM.

`app/lib/marp/render.ts` wird in zwei Schichten aufgeteilt, ohne die vorhandenen Exporte unnoetig zu
brechen:

1. Eine strukturierte Renderfunktion erzeugt `html`, Deck-Metadaten, Source-/Asset-Warnungen und
   einen stabilen Render-Profilnamen.
2. Adapter erzeugen daraus das heutige Web-HTML beziehungsweise den Mobile-v1-Vertrag.

Die gerenderten SVGs bleiben direkte Kinder von `.marpit`. Folienindex, Sichtbarkeit und Fit werden
ueber CSS-Klassen/Attribute an den vorhandenen SVGs gesteuert, nicht ueber neue Wrapper.

### 4.2 Mobile Preview ohne Auth-Token in der WebView

Die App ruft den neuen Endpoint mit ihrem normalen authentifizierten API-Client und explizitem
Workspace-Header auf. Der Server liest die gespeicherte Datei, rendert und gibt ein JSON-Dokument mit
selbstenthaltenem HTML zurueck. Erst danach setzt die App dieses HTML als lokale WebView-Quelle.

Damit gelten folgende Grenzen:

- Better-Auth-Cookies, Bearer-Header und Workspace-ID werden nie in HTML, URL, WebView-Storage oder
  Bridge-Nachrichten kopiert.
- Es gibt keine oeffentliche Marp-Ticketroute und keinen unauthentifizierten Workspace-Assetpfad.
- Die Mobile-WebView erhaelt keine App-Origin und darf keine Navigationen oder neuen Fenster oeffnen.
- Lokale Assets werden serverseitig innerhalb des bereits autorisierten Workspace-Roots gelesen.

### 4.3 Asset-Policy fuer V1

Der V1-Preview-Vertrag ist fuer reproduzierbare Paritaet und Offline-Stabilitaet netzwerkfrei:

- Workspace-relative Bilder und erlaubte Fonts werden nach realpath-/Workspace-Pruefung als Data-URI
  eingebettet.
- Absolute Pfade, `file://`, Symlink-Ausbrueche, `..`, fremde Workspace-Pfade sowie App-Media-URLs
  eines anderen Workspace werden nicht aufgeloest.
- Bereits eingebettete `data:image/*`-Quellen bleiben nur innerhalb der Quell- und Gesamtlimits
  erlaubt.
- Remote `http:`/`https:`-Assets, Medien, Stylesheets und Fonts werden in `marp-mobile-v1` nicht
  geladen. Sie werden durch einen neutralen Platzhalter ersetzt und als
  `REMOTE_ASSET_BLOCKED` gemeldet. Das Fixture fuer Remote Assets prueft genau diesen sicheren,
  sichtbaren Zustand.
- Eine spaetere HTTPS-Allowlist oder ein Server-Proxy waere ein eigenes Security-/Settings-Ticket;
  der Mobile-Request darf Remote-Freigaben niemals selbst einschalten.

Web und Mobile muessen fuer die gemeinsamen Paritaets-Fixtures dasselbe sichere Renderprofil nutzen.
Um bestehende Webdecks nicht unbemerkt zu brechen, wird das Profil zuerst additiv eingefuehrt,
charakterisiert und erst nach einer dokumentierten Web-Regressionspruefung zum gemeinsamen Preview-
Profil gemacht.

Pro Asset bleiben zunaechst maximal 5 MiB erlaubt. Zusaetzlich wird ein Gesamtbudget fuer eingebettete
Assets und das finale HTML festgelegt (Startwert fuer die Implementierung: 20 MiB; in Phase 1 anhand
der Fixtures und Mobile-Speicherprofile bestaetigen). Ueberschreitungen liefern keine teilweise
unmarkierte Praesentation, sondern Warnungen beziehungsweise einen stabilen `413`-Fehler.

### 4.4 HTML-, CSP- und Bridge-Grenze

- User-`script`-Elemente, Event-Handler, Formulare, Frames, Objekte und aktive Navigation bleiben
  verboten.
- Das Mobile-Profil verwendet `default-src 'none'`, `connect-src 'none'`, `object-src 'none'`,
  `base-uri 'none'`, `form-action 'none'`, `frame-src 'none'` sowie ausschliesslich `data:`/`blob:`
  fuer die benoetigten Bild-/Fontquellen. Kein `http:`/`https:` bleibt im CSP.
- Falls Marp-interne SVG-Polyfills Script benoetigen, wird in Phase 1 belegt, welche feste,
  anwendungsseitige Scriptsequenz notwendig ist. Nur diese Sequenz erhaelt einen Hash/Nonce; ein
  pauschales `unsafe-inline` ist im Mobile-Profil nicht zulaessig.
- Die native App injiziert eine kleine, feste Bridge nach dem Laden. Erlaubte Kommandos sind nur
  `goTo(index)`, `setViewport(width,height)`, `setZoom(scale,x,y)` und `measure()`.
- Rueckmeldungen sind versionierte JSON-Nachrichten `ready`, `slideChanged`, `measurement` und
  `renderError`. Index, Masse und Zoom werden auf Typ, Endlichkeit und Grenzen validiert. Inhalte,
  URLs, Tokens und Dateipfade werden nicht ueber die Bridge gesendet.
- `onShouldStartLoadWithRequest` blockiert alle Navigationen ausser das initiale lokale Dokument;
  Links koennen nach expliziter Nutzeraktion ueber eine native, HTTPS-only Linkbehandlung geoeffnet
  werden, nicht innerhalb der Deck-WebView.

### 4.5 Mobile Buehne, Navigation und Rotation

Die mobile Route besitzt nativen State fuer:

- `activeSlideIndex` (nullbasiert intern, einsbasiert angezeigt),
- `slideCount`,
- Viewportmasse und Safe-Area-Insets,
- Fit-Modus und Zoom/Pan,
- Lade-, Refresh-, Offline- und Fehlerzustand.

Verhalten:

- Es ist immer genau eine Folie sichtbar; sie wird per `contain` in die verfuegbare Buehne skaliert.
- Horizontaler Swipe, Zurueck-/Weiter-Buttons und Tastatur-/Accessibility-Aktionen wechseln die
  Folie deterministisch. Am Anfang/Ende wird nicht zyklisch gesprungen.
- Pinch-Zoom wird auf einen in Phase 0 bestaetigten Bereich begrenzt; Doppeltap setzt auf Fit zurueck.
  Navigation setzt Pan zurueck, nicht aber den aktiven Folienindex.
- Rotation remountet das Deck nicht. Der aktive Index bleibt erhalten, Fit wird aus `viewBox` und
  neuem Viewport berechnet, ein manueller Zoomfaktor wird geklemmt weiterverwendet.
- App-Hintergrund/Vordergrund, System-Theme und Safe-Area-Aenderungen duerfen den Index nicht
  veraendern.
- Screenreader erhalten Titel, `Folie X von Y`, Buttonzustand und Fehleralternative. SVGs behalten
  ihre vom Server erzeugten `role="img"`-/`aria-label`-Angaben.
- Dynamische Systemschrift skaliert native Controls, nicht den Deckinhalt und damit nicht die
  Foliengeometrie.

### 4.6 Offline- und Fehlerentscheidung

Ticket 21 fuehrt keinen persistenten Volltext-/HTML-Offlinecache ein. Ein bereits geoeffnetes,
selbstenthaltenes Deck bleibt bei Netzverlust im Speicher sichtbar. Ein neues oder erneut geladenes
Deck zeigt offline einen klaren Zustand mit `Erneut versuchen` und der Alternative `Markdown-Quelle
anzeigen`, sofern diese bereits ueber den normalen Dateicache verfuegbar ist.

Beim Reconnect wird nicht still ein anderer Stand eingeblendet: Die App laedt den Vertrag erneut,
vergleicht `source.sha256` und behaelt bei unveraendertem Stand Index/Zoom. Bei geaendertem Stand
bleibt der Index auf `min(alterIndex, neueFolienzahl - 1)` und die UI meldet die Aktualisierung.

Fehlerhafte oder nicht unterstuetzte Dateien crashen weder React Native noch die WebView. Stabile
Fehlercodes unterscheiden mindestens:

- `MARP_FILE_REQUIRED` (`400`),
- `MARP_FILE_NOT_FOUND` (`404`),
- `MARP_SOURCE_TOO_LARGE` / `MARP_RENDER_TOO_LARGE` (`413`),
- `MARP_RENDER_INVALID` (`422`),
- `MARP_RENDER_FAILED` (`500`),
- normale Auth-/Workspace-Antworten `401`/`403`/`404`,
- Netzwerk/Offline als Clientzustand.

Die sichere Alternative ist der native Markdown-Lesemodus beziehungsweise Download/Teilen, nicht
eine oeffentliche Share-URL und nicht das ungefilterte Laden der Web-App.

## 5. Versionierter Daten- und API-Vertrag

### 5.1 Capability und File-Discovery

Compatibility und Bootstrap erhalten additiv die Capability
`files.marp_preview.v1`. Alte Apps ignorieren sie; neue Apps zeigen ohne Capability weiterhin den
normalen Markdown-Lesemodus.

`MobileFileEntry` erhaelt kein paralleles boolesches Feld mit unklarer Prioritaet, sondern einen
additiven Renderhinweis:

```ts
renderKind: 'marp' | null
```

`openKind` bleibt fuer Rueckwaertskompatibilitaet `markdown`. Der Server bestimmt `renderKind` fuer
namensbasierte Marp-Dateien ohne Dateiinhalt. Fuer generische `.md`-Dateien mit Front-Matter muss der
Detail-/Open-Flow den vorhandenen Detect-Service verwenden oder die Erkennung beim Detail-Lesen
ausfuehren; ein Listing darf nicht tausende Dateien oeffnen. Diese Zweistufigkeit wird in Contract-
Tests festgeschrieben.

### 5.2 Endpoint

Neuer Adapter:

```text
POST /api/mobile/v1/files/marp-preview
X-Canvas-Workspace-Id: <workspaceId>
Content-Type: application/json

{ "path": "presentations/demo.marp.md" }
```

Der Client sendet keinen Markdown-Inhalt und keine Asset-URLs. Der Server liest immer den aktuellen,
gespeicherten Stand aus dem autorisierten Workspace. Web-Entwurfspreview und Mobile-Read-only-
Preview bleiben dadurch bewusst getrennte Use Cases ueber denselben Render-Service.

Erfolgsantwort, `Content-Type: application/json`, `Cache-Control: private, no-store`,
`Vary: Cookie, Authorization, x-canvas-workspace-id`:

```json
{
  "success": true,
  "render": {
    "contractVersion": "marp-preview.v1",
    "profile": "marp-mobile-v1",
    "source": {
      "path": "presentations/demo.marp.md",
      "sha256": "<hex>",
      "sizeBytes": 1234,
      "modifiedAt": "2026-08-21T12:00:00.000Z"
    },
    "deck": {
      "title": "Demo",
      "slideCount": 3,
      "slides": [
        { "index": 0, "width": 1280, "height": 720 }
      ]
    },
    "html": "<!doctype html>...",
    "warnings": [
      {
        "code": "REMOTE_ASSET_BLOCKED",
        "slideIndex": 1,
        "reference": "https://example.invalid/image.png"
      }
    ]
  }
}
```

Details des finalen Schemas:

- `slides` enthaelt einen Eintrag je Folie, auch wenn alle dasselbe Format besitzen. Damit bleiben
  kuenftige gemischte Formate additiv darstellbar.
- `reference` wird normalisiert und darf keine lokalen absoluten Pfade oder Credentials enthalten.
- Engine-/Paketversion kann als Diagnosefeld aufgenommen werden, ist aber keine Clientlogik; der
  Client entscheidet ausschliesslich anhand `contractVersion` und Capability.
- Die Serverroute wendet ein Mobile-spezifisches Rate Limit an und protokolliert nur Fehlercode,
  Workspace-ID und gehashten/normalisierten Pfad, niemals Markdown, HTML oder Data-URIs.
- Eine unbekannte Major-Contract-Version wird fail-closed mit Markdown-Fallback behandelt.

## 6. Gemeinsame Fixtures und erwartete Ergebnisse

Kanonischer Ort im Notebook-Repository:

```text
fixtures/mobile/marp-preview/v1/
  manifest.json
  default-16x9.marp.md
  classic-4x3.marp.md
  frontmatter-theme.marp.md
  local-assets.marp.md
  remote-assets-blocked.marp.md
  code-and-long-content.marp.md
  malformed-frontmatter.marp.md
  assets/
    checker.png
    local-font.woff2
```

`manifest.json` enthaelt fuer jedes Deck mindestens Source-SHA-256, erwartete Folienzahl,
Foliengroessen, erwartete Warncodes, benoetigte lokale Assets und die Namen der visuellen
Referenzaufnahmen. Binaere Fixtures bleiben klein und lizenzrechtlich eindeutig selbst erzeugt.

Das Mobile-Repository checkt eine exakte Kopie unter seinem vorhandenen Fixture-Konventionspfad ein.
Ein Export-/Verify-Skript im Notebook erzeugt ein Manifest mit Contract-Version und SHA-256 aller
Dateien; Mobile-CI prueft dieses Manifest gegen den referenzierten Notebook-Commit/Release. Es gibt
keine Symlinks, Submodule oder Laufzeit-Dateisystemabhaengigkeit zwischen den Repositories.

Die Fixture-Matrix deckt ab:

| Fixture | Zweck | Erwartung |
| --- | --- | --- |
| `default-16x9` | Front Matter, Standardtheme, Text, Listen, mehrere Folien | gleiche Folienzahl und 16:9-Geometrie auf Web/iOS/Android |
| `classic-4x3` | abweichendes Seitenformat | keine Streckung; Fit mit korrekten Letterbox-Raendern |
| `frontmatter-theme` | directives, style, Hintergrund, direkte Marp-CSS-Selektoren | keine Wrapper-Regression; Farben/Typografie innerhalb definierter Toleranz |
| `local-assets` | relative Bild-/CSS-URL, Leerzeichen/Unicode im Pfad, lokaler Font | nur autorisierter Workspace-Inhalt eingebettet; kein absoluter Pfad im Ergebnis |
| `remote-assets-blocked` | HTTP, HTTPS und protokollrelative Referenz | kein Netzwerkrequest; Platzhalter und `REMOTE_ASSET_BLOCKED` |
| `code-and-long-content` | Highlighting, lange Zeilen, uebervolle Folie | Foliengrenze bleibt stabil; Overflow wird sichtbar gemeldet, App bleibt bedienbar |
| `malformed-frontmatter` | Parser-/Renderfehler | stabiler Fehler/Fallback, kein Crash und kein teilweises aktives HTML |

Zusaetzliche Security-Fixtures werden im Servertest zur Laufzeit in getrennten temporaeren Personal-
und Team-Workspace-Roots erzeugt: `../`-Traversal, absoluter Pfad, Symlink nach aussen, gleichnamiges
Asset im fremden Workspace, zu grosses Asset und MIME-/Extension-Mismatch. Diese Daten gehoeren nicht
in visuelle Goldens.

## 7. Strikt sequenzielle Implementierungsphasen und Commits

Keine Phase beginnt, bevor Gate und fokussierter Commit der vorherigen Phase abgeschlossen sind.
Serververtrag wird vor Mobile-Integration ausgeliefert; ein Mobile-Client darf nie gegen einen noch
nicht festgeschriebenen Draft implementiert werden.

### Phase 0 - Runtime-Reproduktion auf dem inventarisierten Mobile-Stand, noch ohne Produktivcode

1. Den bereits inventarisierten Mobile-Commit `69e16e4` beziehungsweise dessen spaeteren,
   bewusst festgehaltenen Implementierungs-Base-Commit verwenden; `AGENTS.md` erneut gegen den
   Arbeitsauftrag pruefen.
2. Mit temporaeren Kopien der fuer Phase 1 vorgesehenen Faelle mindestens `default-16x9`,
   `classic-4x3`, lokale/remote Assets, langen Code und eine fehlerhafte Datei auf iOS und Android
   reproduzieren.
3. Belegen, dass der aktuelle Files-Open-Flow auf `NotebookDocumentScreen` landet und dass
   `detectMarpFile()` nur im Export-Aktionsblatt ausgefuehrt wird.
4. Screenshots, OS/WebView/App-Version und beobachteten Datei-/Rotationszustand im Ticket-PR
   dokumentieren; keine Zugangsdaten oder private Dateiinhalte erfassen.

Gate: Jede Fehlerhypothese aus Abschnitt 3 ist als bestaetigt, widerlegt oder nicht reproduzierbar
markiert; die finalen Mobile-Dateipfade und Testcommands sind bekannt.

Commit: kein Produktivcommit; falls noetig nur ein fokussierter Mobile-Dokumentationscommit
`Document Marp mobile reproduction`.

### Phase 1 - Kanonische Fixtures und Charakterisierung im Notebook

1. Fixture-Verzeichnis und `manifest.json` anlegen.
2. `scripts/marp-preview-render-test.ts` zu fixture-basierten Struktur-/Metadatenpruefungen
   erweitern oder in fokussierte Tests aufteilen.
3. Direkte `.marpit > svg`-Kinder, Folienzahl, `viewBox`, 16:9/4:3, Theme-CSS, lokale Assets und
   heutige Remote-Asset-Ausgabe charakterisieren.
4. Eigenen `package.json`-Befehl fuer die Marp-Renderpruefungen anlegen und in den passenden
   Server-/Mobile-Vertrags-Testpfad aufnehmen.

Gate: Fixtures sind deterministisch, klein, lizenziert und schlagen bei der historischen Wrapper-
Regression nachweislich fehl.

Commit Notebook: `Add versioned Marp mobile fixtures`.

### Phase 2 - Strukturierten Renderer und sichere Asset-Policy implementieren

1. In `app/lib/marp/render.ts` beziehungsweise kleinen Hilfsmodulen ein strukturiertes Ergebnis mit
   Slide-Metadaten und Warnungen einfuehren.
2. Netzwerkfreies `marp-mobile-v1`-Profil, Gesamtbudgets, Platzhalter und stabile Warncodes
   implementieren.
3. Pfad-/Symlink-/Cross-Workspace- und MIME-Grenzen mit getrennten Workspace-Fixtures testen.
4. Mobile-CSP und Scriptbedarf der Marp-SVG-Ausgabe festschreiben; keine breite Scriptfreigabe.
5. Bestehende Webpreview, Public Preview und Exporte als Regression ausfuehren, ohne sie in diesem
   Commit unnoetig auf das neue Profil umzuschalten.

Gate: Renderer erzeugt fuer identische Eingaben deterministische Metadaten; kein Test beobachtet
einen Netzwerkzugriff oder fremde Workspace-Bytes; alte Web-/Exportpruefungen bleiben gruen.

Commit Notebook: `Harden shared Marp render contract`.

### Phase 3 - Mobile-v1-Vertrag und Discovery implementieren

1. Kanonische Typen/Validatoren unter `app/lib/mobile/` anlegen.
2. `MobileFileEntry.renderKind`, zweistufige Erkennung und die neue Preview-Route implementieren.
3. Capability in Compatibility und Bootstrap additiv aufnehmen.
4. Auth-, Read-Permission-, falscher Workspace-, Missing-/Oversize-/Invalid-/Rate-Limit- und
   Redaction-Tests ergaenzen.
5. Fixture-Export/Verify-Skript fuer das Mobile-Repository bereitstellen.
6. `npm run lint`, die fokussierten Marp-/Mobile-Tests und `npm run build` ausfuehren. Kein Container
   ist fuer Ticket 21 erforderlich.

Gate: Der gespeicherte Serverstand kann nur aus einem leseberechtigten Workspace als
`marp-preview.v1` geladen werden; alte Mobile-Clients und bestehende Export-Aliase bleiben kompatibel.

Commit Notebook: `Add mobile Marp preview API`.

### Phase 4 - Mobile-Vertrag importieren und Read-only-Screen integrieren

1. Exakte Fixtures/Schemaartefakte mit Notebook-Commit/Manifest-SHA im Mobile-Repository einchecken.
2. `src/features/files/contracts.ts` und `api.ts` um Pfadkonstante, Runtime-Validator,
   `fetchMarpPreview()` und die stabilen Fehlercodes ergaenzen.
3. In `src/features/files/navigation.ts` getrennte `marpFileHref()`-/Chat-Routen einfuehren und die
   neuen Expo-Router-Dateien unter `src/app/(app)/(tabs)/files/marp/[documentPath].tsx` sowie
   `src/app/(app)/chat/file/marp/[documentPath].tsx` anlegen.
4. `src/features/files/files-browser-screen.tsx` so erweitern, dass `renderKind: 'marp'` direkt und
   generisches Markdown nach erfolgreichem bestehendem Detect als Praesentation geoeffnet wird. Der
   Detect-Lade-/Fehlerzustand muss den Tap deterministisch behandeln und darf keine doppelte
   Navigation ausloesen.
5. Chat-Dateireferenzen und der generische `files/view`-Redirect verwenden dieselbe Routingfunktion,
   damit Marp nicht je nach Einstiegspunkt unterschiedlich geoeffnet wird.
6. Bei fehlender Capability, unbekannter Contract-Version oder Detect-Fehler sicher auf die heutige
   Markdown-Route zurueckfallen. Dort bleibt eine explizite Vorschauaktion moeglich, sobald die
   Capability vorhanden ist.
7. `scripts/files-foundation-test.ts` um Discovery, Parser, Files-/Chat-Routen, Workspace-Wechsel und
   Fallback erweitern; `npm run test:files` ausfuehren.

Gate: Kein Marp-HTML wird ohne erfolgreich validierten Vertrag in eine WebView gegeben; falsche
Workspace-/Instanz-Caches werden nicht wiederverwendet.

Commit Mobile: `Add Marp preview contract client`.

### Phase 5 - Buehne, Navigation, Zoom und Rotation implementieren

1. `src/features/files/marp-presentation-screen.tsx` mit `useCanvasWorkspace()`, workspace-gescoptem
   Query-Key, Safe-Area-Buehne, nativen Controls sowie `Markdown bearbeiten`-Fallback bauen.
2. Eine eigene `marp-webview.native.tsx` samt Props/Bridge-Helfer und sicherem Web-Fallback anlegen.
   Sicherheitsflags aus `html-webview.native.tsx` werden uebernommen, aber URI-Navigation,
   DOM-Storage, Downloads, Fenster und HTML-Ticket-Scope nicht.
3. Versionierte Bridge, eine sichtbare Folie, Fit-Berechnung, Swipe/Buttons, Pinch/Reset und
   Accessibility mit den bereits installierten Gesture-/Reanimated-/WebView-Abhaengigkeiten
   implementieren.
4. `useWindowDimensions()`, Safe-Area-Insets und `onLayout` statt eines neuen Orientation-Moduls
   verwenden, solange Phase 0 keinen Plattformblocker belegt.
5. Index/Zoom ueber Layout-, Rotation-, App-State- und Theme-Aenderungen stabil halten.
6. iOS-/Android-Komponententests und vorhandene native E2E-Werkzeuge fuer Vor/Zurueck,
   Boundary-Zustaende und Rotation ergaenzen.

Gate: Beide Plattformen zeigen alle Fixture-Formate unverzerrt; zehn wiederholte Rotationen und
Vor/Zurueck-Wechsel verlieren weder Folie noch Bedienbarkeit und erzeugen keinen WebView-Reload-Loop.

Commit Mobile: `Add native Marp presentation stage`.

### Phase 6 - Fehler, Offline und Sicherheits-Hardening integrieren

1. Initial Load, Refresh, in-memory Offline, Reconnect mit Source-Hash, Sessionablauf, Access Denied,
   invalides Deck und Renderbudget-Zustaende fertigstellen.
2. Markdown-/Download-Alternative, Retry und Remote-/Overflow-Warnungen nutzerverstaendlich
   anzeigen.
3. WebView-Navigation, Cookie-/Storage-Zugriff, externe Requests, Fenster, Downloads und Bridge-
   Payloads auf iOS und Android negativ testen.
4. Fuer Netzstatus das vorhandene `expo-network`-/App-State-Muster aus dem Realtime-Provider in eine
   kleine allgemeine Hook extrahieren oder lokal aequivalent kapseln; keine Abhaengigkeit vom
   Chat-Realtime-State erzeugen.
5. Logout, Instanzwechsel und Workspace-Wechsel auf HTML-/State-Cleanup sowie
   `queryClient.clear()`-/workspacegescopte Query-Keys pruefen.
6. `src/i18n/copy.ts` und `docs/files.md` um Marp-Preview-, Warn- und Fallbacktexte ergaenzen.

Gate: Kein Authmaterial erscheint in WebView, URL, Logs oder Snapshots; fremde Assets und Remote-
Ressourcen werden nicht geladen; Fehler lassen die App bedienbar.

Commit Mobile: `Harden Marp mobile preview states`.

### Phase 7 - Webangleichung und visuelle Paritaetsabnahme

1. Webpreview kontrolliert auf denselben sicheren Renderprofil-Vertrag umstellen, sofern die in
   Phase 2 dokumentierte Regression keine Produktentscheidung blockiert.
2. Gemeinsame Fixtures auf Web, iOS und Android mit identischer Viewport-/Theme-Matrix aufnehmen.
3. Folienzahl, Bild-/Textposition, Farben, Code, lokale Assets und Seitenverhaeltnis automatisch
   beziehungsweise mit dokumentierter Toleranz vergleichen.
4. Manuelle Realgeraeteabnahme inklusive Rotation, Safe Areas, Screenreader, grosser Systemschrift,
   Flugmodus/Netzwechsel und Sessionablauf durchfuehren.
5. Produktdokumentation, Capability-Mindestversion und Release Notes aktualisieren; Ticket/Index erst
   nach beiden Repository-Commits und bestandener Abnahme auf erledigt setzen.
6. Notebook nochmals mit fokussierten Tests, `npm run lint` und `npm run build` pruefen. Mobile
   mindestens mit `npm run test:files` waehrend der fokussierten Commits und vor Abschluss mit dem
   verbindlichen Vollgate `npm run verify` pruefen; native E2E-/Realgeraete-Befehle gemaess der in
   Phase 0 dokumentierten Freigabe ausfuehren.

Gate: Alle Kriterien aus Abschnitt 10 sind protokolliert bestanden; keine offene P0/P1-Security-
oder Crash-Abweichung und keine unerklärte visuelle Differenz.

Commits: je Repository ein fokussierter Abschlusscommit, nur falls fuer Goldens/Dokumentation noch
noetig, zum Beispiel `Align Marp preview parity baselines`.

Browser-/Playwright- oder native UI-Tests werden in der Implementierungsaufgabe nur nach der nach
Repository-Regeln erforderlichen expliziten Freigabe gestartet. Dieser Plan fuehrt sie nicht aus.

## 8. Automatisierte Testmatrix

### Notebook/Server

| Ebene | Konkrete Pruefung |
| --- | --- |
| Detection | Namensalias, Front Matter, Kommentar, generisches Markdown, Gross-/Kleinschreibung, Oversize-Detect |
| Renderer | Folienzahl, `viewBox`, direkte SVG-Kinder, Theme-CSS, Code, Unicode, 16:9/4:3, Warnungen, deterministisches Ergebnis |
| Assets | relative/URL-kodierte Pfade, CSS `url()`, lokaler Font, fehlend, zu gross, Data-URI, remote blockiert |
| Isolation | Traversal, absoluter Pfad, Symlink aus Root, fremder Personal-/Team-Workspace, App-Media-URL mit falschem Scope |
| HTML Security | Allowlist, kein User-Script/Event-Handler/Form/Frame, restriktiver CSP, keine absolute Pfad-/Tokenausgabe |
| API | 200-Schema, 400/401/403/404/413/422/429/500, `Cache-Control`, `Vary`, Redaction und Rate Limit |
| Compatibility | Capability in Public Compatibility und authentifiziertem Bootstrap, alte Felder unveraendert |
| Regression | Webeditor-Preview, Public Preview, PDF/Bildexport und bestehende Mobile-Datei-/HTML-Preview-Tests |

### Mobile iOS/Android

| Ebene | Konkrete Pruefung |
| --- | --- |
| Runtime Contract | unbekannte Version, fehlende Capability, invalide Response, Warning-/Error-Mapping |
| File Routing | namensbasierte Marp-Datei, Front-Matter-Detect, normales Markdown, Workspace-/Instanzwechsel |
| Component | Initial Load, Retry, Offline, Markdown-Fallback, Remote-Warnung, Accessibility-Labels |
| Bridge | ungueltige Nachricht, Out-of-range-Index, NaN/Infinity, doppelte `ready`-Events, Reload/Unmount |
| Gestures | Swipe, Buttons, Boundary, Pinch, Doppeltap, Scrollkonflikt und Reduced Motion |
| Lifecycle | Portrait/Landscape, Split-/Window-Resize soweit unterstuetzt, Background/Foreground, Dark Mode |
| Security | keine Cookies/Tokens, keine externe Navigation/Requests, kein fremder Cache nach Logout/Workspacewechsel |
| Native E2E | Fixture oeffnen, Folie wechseln, rotieren, offline gehen, reconnecten, Fehlerfallback oeffnen |

## 9. Visuelle Paritaetsmatrix und Toleranzen

Verglichen werden nicht rohe Ganzseiten-Screenshots mit unterschiedlicher nativer Chrome, sondern
der zugeschnittene Folieninhalt derselben Fixture-Folie. Native Controls werden separat per
Komponentensnapshot abgenommen.

Matrix:

- Web: Chromium bei 390x844 und 844x390 CSS-Pixeln,
- iOS: mindestens aktuelles und ein aelteres unterstuetztes iPhone, Portrait/Landscape,
- Android: mindestens ein aktuelles API-Level und ein kleineres/aelteres unterstuetztes Phone,
  Portrait/Landscape,
- Fixtures: alle gueltigen Decks aus Abschnitt 6, jeweils erste, mittlere und letzte Folie.

Automatisch hart gleich muessen sein:

- Folienzahl und Reihenfolge,
- Source-/Fixture-Hash,
- Folienbreite, -hoehe und Seitenverhaeltnis,
- Vorhandensein/Blockstatus jedes Assets,
- Textinhalt und Codeblockinhalt.

Pixelvergleich:

- Goldens werden pro Rendering-Engine-/Plattformfamilie versioniert, weil native WebViews leichte
  Font-Antialiasing-Abweichungen besitzen.
- Starttoleranz: maximal 0,5 % abweichende Pixel ausserhalb einer kleinen Anti-Aliasing-Schwelle;
  jede groessere Abweichung wird manuell klassifiziert und nicht pauschal neu gebaselined.
- Keine Toleranz gilt fuer abgeschnittene Folien, falsches Seitenverhaeltnis, fehlende Bilder,
  verschobene Foliengrenzen oder falsche Farben/Flaechen.
- Fonts muessen als Fixture-Asset eingebettet sein; Systemfont-Fallback darf visuelle Goldens nicht
  zufaellig bestimmen.

## 10. Konkrete Abnahmekriterien

Ticket 21 ist erst abgeschlossen, wenn alle folgenden Aussagen belegt sind:

1. Dieselben versionierten Fixture-Hashes werden in Notebook und Mobile verwendet.
2. Web, iOS und Android melden fuer jedes gueltige Fixture dieselbe Folienzahl, Reihenfolge und
   Geometrie.
3. 16:9- und 4:3-Folien werden in Portrait und Landscape unverzerrt und ohne unkontrollierten
   Viewport-Overflow dargestellt.
4. Standardtheme, Fixture-Theme, Text, Code und lokale Bild-/Fontassets bestehen die visuelle
   Toleranzmatrix.
5. Remote Assets erzeugen keinen Netzwerkrequest, sondern einen sichtbaren, sicheren Warnzustand.
6. Traversal, absolute Pfade, Symlink-Ausbrueche und fremde Workspace-Assets liefern keine fremden
   Bytes und leaken keine absoluten Pfade.
7. Unauthentifizierte Requests, abgelaufene Sessions und nicht leseberechtigte Requests liefern den
   festgelegten Fehler; der Client faellt sicher zurueck.
8. Swipe, Buttons, Accessibility-Aktion, Zoom/Reset und Grenzzustaende funktionieren auf iOS und
   Android.
9. Rotation, Background/Foreground und Layoutwechsel behalten den aktiven Folienindex; Fit/Zoom
   bleibt gemaess Abschnitt 4.5 stabil.
10. Netzverlust bei geoeffnetem Deck laesst den sichtbaren Stand nutzbar; ein neuer Offline-Aufruf
    zeigt einen klaren Zustand und keine endlose Ladeanzeige.
11. Geaenderter Source-Hash nach Reconnect aktualisiert kontrolliert und klemmt einen nicht mehr
    vorhandenen Index sicher.
12. Fehlerhafte, zu grosse und nicht unterstuetzte Decks crashen weder React Native noch WebView und
    bieten Markdown-/Download-Alternative.
13. Kein Auth-Token, Cookie, Markdown-/HTML-Inhalt oder vollstaendiger lokaler Pfad erscheint in
    Bridge-Nachrichten, URLs, Analytics oder Fehlerlogs.
14. Fokussierte Server-/Mobile-Tests, Lint/Typecheck, Notebook-`npm run build` und manuelle
    Realgeraeteabnahme sind dokumentiert erfolgreich.

## 11. Risiken, Migration und Rollback

| Risiko | Gegenmassnahme | Rollback |
| --- | --- | --- |
| Marp-/Theme-CSS bricht durch DOM-Umbau | direkte SVG-Kinder als Contract und Regressionstest | Mobile-Stage deaktivieren, Markdown-Fallback; Rendererprofil zurueckschalten |
| Selbstenthaltenes HTML wird auf grossen Decks speicherintensiv | Quell-, Einzelasset-, Gesamtasset- und HTML-Limits; Realgeraeteprofiling | Capability serverseitig entfernen; Client faellt auf Markdown zurueck |
| Remote-Asset-Blockierung aendert bestehendes Webverhalten | neues Profil erst additiv, Webumschaltung erst nach Regression und Release Note | Web bleibt temporaer auf altem Profil; Mobile bleibt sicher blockierend |
| Native WebViews rendern SVG/Fonts unterschiedlich | eingebettete Fonts, Plattform-Goldens, reale Geraete | betroffene Plattformversion per Capability/Mindestversion sperren oder Markdown-Fallback |
| App/Server werden nicht gleichzeitig ausgerollt | additive v1-Capability, Runtime-Validator, Server zuerst | alte App ignoriert Capability; neue App nutzt Fallback ohne Capability |
| Workspace-Zugriff wird waehrend Anzeige entzogen | keine WebView-Credentials, kein persistenter Deckcache, Revalidate bei Reload/Reconnect | Screen schliessen und Cache/State beim naechsten 403/404 verwerfen |
| Fixture-Drift zwischen privaten/oeffentlichen Repositories | SHA-Manifest und CI-Verifikation | Mobile-PR blockieren, bis exakt passender Fixture-Satz importiert ist |
| Ticket 22 veraendert gemeinsame Marp-Fixtures | Ticket 21 besitzt Render-/Asset-Erwartungen; Roundtrip-Erwartungen in separaten Dateien/Manifestfeldern | Commits nacheinander rebasen, keine konkurrierenden unaufgeteilten Fixture-Aenderungen |

Es ist keine Datenbankmigration vorgesehen. Die API-Aenderung ist additiv. Der Server wird zuerst
ausgerollt; erst wenn `files.marp_preview.v1` sichtbar ist, aktiviert die Mobile-App den Screen. Ein
Rollback kann deshalb ueber Capability-Entfernung/Featureflag und Markdown-Fallback erfolgen, ohne
gespeicherte Workspace-Dateien zu migrieren oder zu veraendern.

## 12. Abschlussartefakte

- dieses validierte Planungsdokument und Link aus Ticket 21,
- Reproduktionsprotokoll aus Phase 0 im spaeteren Implementierungs-PR,
- kanonische Fixture-/SHA-Manifeste in beiden Repositories,
- versionierter `marp-preview.v1`-Vertrag und Capability,
- automatisierte Server-, Mobile- und Sicherheitsnachweise,
- visuelle Web-/iOS-/Android-Baselines,
- manuelles Realgeraete-Abnahmeprotokoll,
- je Repository fokussierte Commits und erst danach Statusaktualisierung im Ticketindex.

## 13. Implementierungsstand vom 2026-08-21

Die additive V1-Implementierung ist in getrennten Worktrees committed:

- Notebook: `d8f097e5 Add mobile Marp preview contract` fuegt `POST
  /api/mobile/v1/files/marp-preview`, die Capability `files.marp_preview.v1`, einen gespeicherten,
  workspace-authentifizierten Renderpfad, die Profile `marp-mobile-v1`/`marp-preview.v1` und die
  Fixtures `basic.marp.md` sowie `remote-asset.marp.md` hinzu. Remote-Assets werden nicht geladen;
  der Vertrag liefert stattdessen `REMOTE_ASSET_BLOCKED`.
- Mobile: `d5659a0 Render Marp presentations in mobile files` validiert den Vertrag fail-closed,
  routet erkannte Decks aus Files und Chat in eine getrennte Read-only-Buehne und verwendet eine
  lokale WebView-Quelle ohne Cookie-/Header-/URL-Uebergabe. File-, Storage-, Mixed-Content-,
  Fenster- und Top-Level-Navigation sind dort deaktiviert.

Erfolgreiche automatisierte Nachweise: der Server-Marp-Renderer-Test sowie die Server-Mobile-Files-,
Compatibility- und Bootstrap-Tests; im Mobile-Worktree `npm run test:files` und `npm run lint`.
`npm run verify` erreicht einen vorbestehenden, nicht von Ticket 21 beruehrten Typecheck-Fehler in
`src/features/notebook/notebook-rich-editor.native.tsx` (`keyboardDismissMode` ist in der aktuellen
`@expo/dom-webview`-Typdefinition nicht vorhanden). Der neue Marp-Code erzeugt keinen Typecheck-Fehler.

Die Realgeraete-/Simulator-Abnahme, visuelle Goldens, Swipe/Zoom und die in Abschnitt 10 genannten
Rotation-, Offline- und Plattformparitaetskriterien bleiben offen. Sie wurden nicht ausgefuehrt, weil
in diesem Auftrag keine Browser-/Playwright- oder Device-Tests autorisiert waren. Vor Release ist
diese Restabnahme verpflichtend nachzuholen; bis dahin bleibt der Status bewusst nicht `completed`.
