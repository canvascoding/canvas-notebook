# I-06: Neue Markdown-Dokumente vor dem ersten Einfügen sicher anlegen

Stand: 15.10.2026. **Sourceanschluss und unabhängige Integrationsprüfung abgeschlossen.** Die [tatsächlichen Nachweise und Grenzen](./markdown-manual-create-integration-evidence.md) bleiben von Browserabnahme und Produktaktivierung getrennt. Grundlage ist der integrierte I-05-Stand `ba56bec85c3829fb86f1631510afeb2f91ebe37c` im Worktree `824c`. Dieser Detailplan konkretisiert I-06 des [Create-/Paste-/Importplans](./markdown-create-paste-full-import-integration-plan.md).

## Gewünschter Ablauf

Homepage und Dateibrowser behalten ihre vorhandenen Formulare. Eine neue `.md`-/`.markdown`-Datei wird zuerst als tatsächlich leeres natives Dokument mit eigener erster Dateiveröffentlichung angelegt. Erst ein bestätigter Abschluss öffnet den Editor. Dort kann der Benutzer unmittelbar tippen oder normalen Text einfügen. Die entfernte Read/Edit-Auswahl ist dafür nicht erforderlich.

Gewöhnliches Paste verwendet weiterhin die vorhandenen Absatz-, Inline-, Wiki-, Mention- und URL-Regeln. Es verspricht keinen vollständigen Markdown-Import und keine durchgehend literale Syntax. Für bewusst strukturierten Markdown-Text bleibt **Einfügen → Markdown einfügen** vorgesehen; vollständige Originaldateien einschließlich Frontmatter verwenden den Dateiimport. Diese drei Wege erhalten eigene echte Browserfälle.

## Tatsächliche Lücke

`createWorkspacePath` und der installierte native Files-Create-Client betrachten bisher jede HTTP-2xx-Antwort als Erfolg. Eine Antwort mit offenem Abschluss und Status 202 würde deshalb bereits Navigation beziehungsweise Öffnen auslösen. Die bisherige manuelle Markdown-Anlage schreibt außerdem zunächst eine rohe leere Datei; die native Initialisierung folgt erst beim Öffnen. Ohne stabilen Auftrag kann ein verlorenes Ergebnis nicht eindeutig demselben Create zugeordnet werden.

## Gemeinsamer öffentlicher Vertrag

Nur eine gewöhnliche Datei mit `.md` oder `.markdown` und ohne Excalidraw-Template verwendet den neuen Vertrag. Ordner, andere Dateitypen, Word und Zeichnungen behalten ihre bisherigen Wege. Mobile Files-Create erbt die vorhandene Webroute. Das separate mobile Notebook-Template `# Titel\n\n` bleibt ein eigener, semantisch nicht leerer Create.

Der bestehende POST `/api/files/create` erhält für Markdown `path`, `type: 'file'` und eine vor dem ersten Senden erzeugte UUID `requestId`. Der Workspaceheader bleibt während dieses Versuchs fest. Actor und echte Authsession werden ausschließlich aus dem Originalrequest bestimmt; der Client übergibt keine Quellenbytes, Hashes, Grants oder nativen Proofs.

| Ergebnis | HTTP und öffentliches Verhalten |
| --- | --- |
| `completed` | 200, `success: true`, `completion` mit Status, `requestId`, `workspaceId` und `targetPath`. Erst nach bestätigter nativer Anlage, eigener physischer Geburt, vollständiger Closure und geprüften Createfolgen. |
| `projection_pending` | 409, `success: false`, endlicher Code `MARKDOWN_CREATE_PROJECTION_PENDING` und dieselbe gebundene Completion-Koordinate. Kein Öffnen. |
| `recovery_required` | 409, `success: false`, Code `MARKDOWN_CREATE_RECOVERY_REQUIRED`. Ein unklares oder abweichendes Ergebnis wird nicht als eigener Erfolg adoptiert. |
| `unavailable` | 409, `success: false`, Code `MARKDOWN_CREATE_NATIVE_UNAVAILABLE`. Bei geschlossenem Produktgate keine neue native Mutation, Claiminitialisierung oder rohe Ersatzdatei. |
| Fehlende/ungültige Request-ID | 400; keine ungebundene Markdown-Anlage. Tatsächliche Auth-/Rechtefehler behalten ihre passenden Fehlerstatus. |

Idempotenz ist an den echten Actor, die echte Session, den Workspace und die Request-ID gebunden. Der Pfad darf innerhalb dieses Auftrags nicht wechseln. Der vorhandene Store ist workspacegebunden; eine globale UUID-Eindeutigkeit über alle Workspaces wird nicht behauptet und benötigt keine neue DDL. Ein fremder belegter Zielpfad wird weder ersetzt noch automatisch umbenannt.

## Serveranschluss

Die vorhandene Engine für authentisierten nativen Create, ursprünglichen dauerhaften Birth-Claim, Lost-COMMIT-Beobachtung und erste Projektion wird intern geteilt. Es entstehen keine erfundene Uploadsession, zweite große Writerengine oder neuen Principal-/Broker-/SQL-DDL-/FD-Backend-Verträge.

Die zwei privaten Quellenwege sind konkret: tatsächliche Upload-LiveSource mit ihren bisherigen Originalmanifest-/Progress-/Part-/Inode-/TTL-Prüfungen oder intern erzeugte feste Empty-Quelle. Manuelles Create erzeugt genau null UTF-8-Bytes, LF, kein BOM und Blocks/schema1. Es übernimmt keinen Inhalt und kein Titeltemplate.

Die beiden tatsächlichen Veröffentlichungsprüfungen im Python-Helper und synchronen Node-Parent benötigen eine eng validierte zusätzliche Empty-Attribution. Ein freier `kind: manual`-Record genügt dafür ausdrücklich nicht. Der Birth-Einstieg prüft über feste lesende Guards den nur von der echten Manualengine installierten privaten Kontext: Originalbindung, tatsächlicher Owner und Realm, eine reservierte Invocationidentität und während der Veröffentlichung die konkrete aktuelle D-/Native-/Claimphase. Es gibt keinen exportierten Minter, Run-Wrapper oder frei austauschbaren Authoritycallback. Zweiter Entry im selben Kontext, unbekannte Varianten und zusätzliche Sourcefelder werden abgewiesen. Unmittelbar vor dem synchronen Link gelten weiterhin vollständige Ziel-/Eltern-/FD-Prüfung und das bestehende negative Zeitbudget.

Der kanonisch fsync-publizierte Birth-Intent und die bestehenden atomaren SQL-Receipts bilden den dauerhaften Versuch. Wiederaufnahme verwendet ausschließlich denselben Auftrag und aktuelle echte `canWrite`-Phasen. Nachgewiesener nativer Commit und bestätigte Dateiveröffentlichung bleiben getrennte Zustände. Vor und nach History, Invalidierung und Audit wird das eigene aktuelle Ergebnis erneut geprüft; tatsächliche Closefehler verhindern eine Erfolgsantwort.

History wird an die bestätigten anfänglichen leeren Bytes und deren echte Revision gebunden. Cacheinvalidierung ist wiederholbar. Audit bleibt beim bestehenden Best-effort-Vertrag; ein Retry nach verlorener Antwort kann einen weiteren zuordenbaren Auditversuch mit derselben Request-ID erzeugen. Ein Exactly-once-Audit wird nicht versprochen. Spätere Peeränderungen werden niemals durch eine erneute leere Genesis ersetzt; passt der ursprüngliche physische Birthbeleg nicht mehr, bleibt die Bestätigung konservativ offen.

Bei geschlossenem Produktgate bleibt auch die Wiederaufnahme lesend: keine Historycapture, Invalidierung oder neuer Auditversuch. Ein nachgewiesener nativer Commit ohne erste fertige Projektion bleibt `projection_pending`; fehlt der Auftrag, lautet das Ergebnis `unavailable`. Ein fertiger nativer Birth allein belegt nicht sämtliche Createfolgen und erhält bei geschlossenem Gate deshalb konservativ `recovery_required`. Es wird kein zusätzliches Routefolgenjournal eingeführt, um daraus nachträglich einen Gesamtabschluss abzuleiten.

## Clientanschluss und Wiederaufnahme

Der generische Promise-void-Createvertrag bleibt erhalten. Nur der Markdownzweig verwendet einen strikten Completionparser und einen typisierten Pendingfehler. Dadurch erreichen offene Ergebnisse weder `onCreated` noch Router- oder Editoröffnung. Auch eine unerwartete 202, falsche Koordinate, unlesbare Erfolgsantwort oder verlorene Antwort bleibt unbestätigt.

Vor dem Dispatch speichert der gemeinsame schmale Attemptstore die feste UUID samt Workspace und Ziel. Gleichzeitiges Absenden wird synchron ausgeschlossen. Eine ausdrückliche Wiederaufnahme sendet genau denselben POST; Reload, Hydration und Workspacewechsel lösen keine automatischen Requests aus. Offene Versuche überleben Dialogschließen und Remount. Für Reload werden höchstens 16 streng geprüfte öffentliche Lookupkoordinaten pro authentifiziertem Konto gespeichert; sie sind keine Berechtigung. Ohne verfügbaren Browserspeicher gilt nur die Lebensdauer der laufenden Seite.

Name, Ziel und Typ eines offenen Versuchs bleiben fest. Eine Änderung des Dateibrowser-Standardpfads darf einen laufenden Dialog nicht zurücksetzen oder wieder freigeben. Späte Ergebnisse aus anderem Workspace oder anderer Authgeneration öffnen kein Dokument und veröffentlichen keine veralteten UI-Folgen. Ein bereits serverseitig bestätigtes Dokument bleibt angelegt, wenn das anschließende Öffnen durch die vorhandene Navigation blockiert wird; dafür wird kein zweiter Create gestartet.

Der installierte Native-Mobile-Files-Client muss offene beziehungsweise ungebundene Aufträge als Nicht-2xx-Fehler erhalten. Eine vollständige neue native Resume-Oberfläche ist eine gesonderte Adapterabnahme; die Webumsetzung allein belegt sie nicht.

## Umsetzung und Abschluss

Server und Client werden innerhalb desselben isolierten Worktrees parallel mit getrennten Dateizuständigkeiten bearbeitet. Die unabhängige Seamprüfung begleitet den Serveranschluss. GitNexus meldet HIGH für den gemeinsamen Createclient und CRITICAL für den Dateibrowserdialog und dessen Hook; betroffen sind Dashboard und Filebrowser. Dynamische Route- und Zustandscaller werden zusätzlich anhand der tatsächlichen Source geprüft.

1. Gemeinsamen Request-/Completionvertrag und private Source-/Birth-Seam umsetzen.
2. Echte Cookie-/Bearer-/PG18-/FS-/Helperfälle für erste Anlage, Konkurrenz, ursprünglichen Retry, Lost-COMMIT, Rechte-/Realm-/Zielwechsel, tatsächliche Closurefehler und Gatefalse ausführen. Vorhandene Uploadregressionen müssen ihre ursprünglichen Sourceprüfungen behalten.
3. Tatsächliche React-/Client-/Storedialoge prüfen: Pending und verlorene Antwort ohne Öffnen, exakt gleicher expliziter Retry, Doppelabsenden, Defaultpfadwechsel, Close/Remount/Reload, Konto-/Session-/Workspacewechsel und unveränderte generische Createwege.
4. Sourceprüfung, TypeScript, Lint und GitNexus-Änderungsanalyse sind mit den getrennten tatsächlichen Nachweisen geschlossen; der fokussierte I-06-Commit enthält diesen Stand. Die zusätzliche Dialoggenerationskorrektur besteht sechs echte Reactfälle.
5. Erst danach I-07 auf frischem integriertem Build: Homepage und Dateibrowser erstellen, erster echter Clipboardpaste, bewusstes Markdowneinfügen, vollständiger Dateiimport, Undo/Redo, Peer, Reload, frischer Browser, Desktop/mobiler Browser, kompakte Breite/Fokus und zwei tatsächliche Hostneustarts. Native Geräte und Produktionsdateireparatur bleiben eigene Nachweise.
