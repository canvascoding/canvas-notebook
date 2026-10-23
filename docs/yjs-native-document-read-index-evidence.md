# Nativer Dokumentindex und sichtbarer Dateibaum

Stand 17. Oktober 2026. Umsetzung im Worktree nach dem [dritten Copy-Browserlauf](./yjs-native-copy-third-browser-evidence.md). Dessen originales Ergebnis bleibt4/6 und fehlgeschlagen. Die nachfolgende Readerintegration benötigt einen neuen Build und die vollständige unveränderte Copy10-Browserabnahme.

## Problem und resultierender Vertrag

Native Copy veröffentlicht dauerhafte Yjs-Dokumente vor deren Markdownprojektion. Die vorherige Web-Linkinventur und der Files-Baum sahen ausschließlich physische Dateien; ein bereits per Session200 gelesenes Dokument erschien deshalb bis zur Projektion als nicht vorhanden. Die neue Inventur verwendet den bestehenden zentralen nativen Katalog und echte native Linkinventories.

Der neue `WorkspaceDocumentLinkIndex` trägt Version2, Workspace-ID, native Dokumentidentität, Metadaten, semantische Links, Ziele und vollständige Coverage-Gaps. Native Links enthalten weder erfundene UTF16-/Bytepositionen noch private Yjs-Anker, Binaries, Katalogbelege oder Kopierrezepte. Physische Quellen behalten ausschließlich echte Vorschaupositionen. Die bestehenden körperlichen Änderungsrezepte bleiben getrennte Typen und werden nicht aus dem Lesemodell erzeugt.

`readWorkspaceDocumentLinkIndex` delegiert genau einmal an den bestehenden `stageWorkspaceLinkSourceAuthorityObservation`. Dessen echter Lese-/Lifecyclefence und echte native sowie physische Quellinventur bleiben erhalten. Ein nicht vollständig beobachteter Workspace wird nicht als erfolgreicher leerer Gesamtindex ausgewiesen. Es handelt sich um persistierte native Inhalte; ungesicherte Liveänderungen werden nicht als aktuelle Indexwahrheit behauptet.

Der Web-Endpunkt und das PI-Tool für Dokumentbeziehungen verwenden denselben Reader. Clientnavigation, Autovervollständigung, Backlinks, Vorschauen und Wissensgraph verwenden dessen semantischen Vertrag. API-Detailantworten und Agentenergebnisse liefern Coverage samt Gaps; Backlinks und Graph zeigen unvollständige Abdeckung auch bei einem globalen Fehler ohne einzelne ausgelassene Datei.

Client und Server verwenden dieselbe vorhandene Wiki-/Exact-Auflösung. Ein explizites natives `target.bin` bleibt gegenüber `target.bin.md` eindeutig; eine echte PDF gegenüber einer nur ähnlich benannten Markdown-Datei ebenfalls. Externe URLs und reine Abschnittsanker erzeugen keine defekten Dokumentbeziehungen oder Missing-Knoten. Eine normale PDF kann als Datei aufgelöst, aber nicht als Markdowninhalt eingebettet werden.

## Files-Baum ohne native Projektionsabhängigkeit

`readWorkspaceDocumentTree` verwendet den bestehenden mehrteiligen nativen Lesefence einschließlich endgültigem Katalogvergleich. Diese Namensraumabfrage lädt keine Yjs-Binaries und exportiert keinen Markdowninhalt. Sie vereinigt tatsächliche physische Einträge mit initialisierten beziehungsweise verlorenen nativen Zuständen und deren logischen Eltern. Eine bloße uninitialisierte Registrierung beweist noch keine Datei.

Der HTTP-Cache enthält weiterhin ausschließlich physische Knoten. Jeder Request, auch ein Cachehit, liest den aktuellen nativen Katalog; die Vereinigung kopiert den physischen Baum tief, bevor Annotationen angefügt werden. Gewöhnliche Assets und echte leere Ordner bleiben erhalten. Native Projektionsgröße, Dateimodus und Projektionszeit werden nicht als native Inhaltsmetadaten ausgegeben. Namen, Workspace-/Organisationsbindung, Aliase, Datei-/Ordnerkonflikte und interne Ausschlüsse bleiben geprüft. Die bisherige Frischegrenze physischer Asset-Caches bleibt bestehen.

Ein tatsächlich fehlender ausgewählter Ordner erhält einen eigenen kontrollierten Fehler und behält am HTTP-Endpunkt den bisherigen leeren200-Vertrag. Ein verlorener Workspace-Root, ein verschwundenes physisches Kind während der Inventur oder eine bekannte native Datei statt eines Ordners werden davon unterschieden; sie können keinen leeren Erfolg erzeugen. Kontrollierte400/403/409/413 bleiben erhalten, unbekannte Fehler liefern500 ohne internen Pfad im Antworttext.

## Bisher tatsächlich ausgeführte Prüfungen

- Neuer Linkindex: zuerst12/12 (55542), nach zusätzlicher echter Reader→Relations/Graph-Gegenprobe13/13 (44386), jeweils Exit0. Echte Yjs-Dokumente aller drei Repräsentationen, gemischte physische Quellen, Assets, Aliase, Fragmente, Kollisionen, fehlende Zustände, Quelllimits und globale Gaps. Keine Behauptung einer neuen PostgreSQL-Laufzeitabnahme durch den injizierten Observer-Test.
- Neuer Baum: zunächst16/16 (4990), nach den getrennten Root-/Auswahl-/Quellfehlern18/18 (99040), jeweils Exit0. Echte eigene Dateisystemfixtures und tatsächlicher Katalogvalidator mit gemockter SQL-Verbindung; keine Behauptung echter PostgreSQL-Lock-/Mehrbackendprüfung.
- Agenten-Dokumentbeziehungen: tatsächlicher Exit0 (2272), Originalprüfungen und zusätzliche native-only-/Teilabdeckungsfälle. Traps verhindern direkten Markdownread, Serializer und den alten Index während des Toolaufrufs.
- Clientindex: tatsächlicher Exit0 (73920), danach erneut mit zusätzlicher PDF-Embed-Lesesperre Exit0 (76608). Ursprüngliche Cache-/Relations-/Fragmentprüfungen bleiben erhalten.
- Achtzehn separat und seriell gestartete lokale Regressionsprogramme bestehen vollständig (90424): Cacheinvalidierung, Navigation, Graph, Referenzgruppen, native Resolver/Links, unveränderte Source-Authority-Stage und eingebetteter SQL-Collector sowie körperliche Diagnose-/Schreibrezepte. Bericht `/var/folders/bx/tjzzmjhn2qdcdyfc_l7hkv900000gn/T/canvas-native-document-read-regressions-2ts61zt6/results.json`, SHA256 `fa743b01ee82039a20dfef1cb32d4b02f7df81d9a4ebfdf502f22c20c60ce351`; alle dort gebundenen Quellen-/Testpins sind vorher/nachher identisch. Diese Folge liegt vor den anschließend eng ergänzten Tree-Fehler- und Embed-Guards; sie wird nicht nachträglich auf andere Bytes umgebunden.
- Die erste vollständige cachefreie Typprüfung mit16GiB endet auf dem damaligen Integrationsstand mit Exit0 (29065), fokussiertes ESLint mit Exit0 (14772). Der finale aktuelle Quellenstand wird nach den Reviewkorrekturen erneut vollständig geprüft.

Die neue HTTP-Caller-Gegenprobe besteht tatsächlich18/18 mit Exit0 (55827). Sie verwendet die tatsächlich kompilierte Route und Fehlerklasse mit gemockten I/O-Grenzen: Auth-/Rate-Limitdurchleitung, kontrollierte Auswahl-/Root-/Quellfehler, Status-/Codes, Cachehit mit erneutem Reader sowie getrennte Stats-/Depth-/Workspacekeys. Sie ist kein SQL-/Dateisystem- oder echter Readertest. Die finale vollständige cachefreie Typprüfung mit16GiB besteht mit Exit0 (51377), fokussiertes ESLint einschließlich aller neuen Tests mit Exit0 (83153). DE/EN-Nachrichten sind als JSON geprüft.

Ein frischer Build und die unveränderte vollständige Browserabnahme auf diesen Quellen bleiben offen. Die bisherigen Browserdeadlines, Workerzahl und null Retries bleiben erhalten. Es gibt keine Projektionswartezeit als Testersatz.

## Änderungsanalyse und verbleibende Abgrenzung

Die gezielte GitNexus-Analyse mit einfachen Symbolnamen meldet für den Clientloader CRITICAL mit12 direkten und36 insgesamt betroffenen Stellen, für die Wiki-Clientauflösung CRITICAL mit5 direkten/24 insgesamt und für Markdown-Embeds HIGH mit2 direkten/11 insgesamt. Diese Reichweite wurde vor den jeweiligen Änderungen gemeldet. Die übrigen untersuchten Leser/Relations-/Graph-Aufrufer sind LOW. Neue Reader-/Tree-Symbole sind noch nicht indexiert: UNKNOWN ist kein Nachweis fehlender Aufrufer. Ein früher paralleler Graphaufruf lieferte Poolfehler beziehungsweise unbrauchbare Nullwerte; die belastbaren gezielten Abfragen wurden anschließend einzeln mit eindeutigen Namen wiederholt.

Die Integration ersetzt nicht den noch offenen vollständigen API-/MCP-/PI-/Mobile-Vertrag, externe SDK-/Skill-Auslieferung, progressive Gesamtsuche oder PDF→native Importanlage. Insbesondere die alten körperlichen Agenten-Änderungsdiagnosen bleiben vorerst an ihrem eigenen Ausgangsindex; ihre unveränderten Regressionen beweisen keine vollständige native Such-/Diagnosemigration. Move/Delete-V2-Anschluss und übrige Sandboxabnahme bleiben ebenfalls offen.

Dateiaktions-Undo bleibt für alle Dateitypen und Ordner aus, ebenso das experimentelle Review Center. Keine allgemeine Aktivierung, kein Produktionsrollout und keine Container-/Image-Erstellung.
