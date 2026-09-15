# FVRC-801 Notification-entry evidence

Datum: 15. September 2026

## Implementierter Umfang

NotificationBell und Home oeffnen eine `file.change_review_required`-Notification im selben Fenster im einen globalen File Version Center. Beide Einstiege verwenden das vorhandene `FileClock`-Icon sowie zustandsspezifische deutsche und englische Texte fuer `needs_review`, `partially_applied`, `semantic_conflict` und `direct_apply_failed`. Home behaelt den Workspace-Namen in der sichtbaren Statuszeile; das responsive Notification-Sheet schliesst kontrolliert, bevor der Center geoeffnet wird.

Der datenminimierte Link enthaelt nur Workspace, Lineage und Agentenoperation. Er setzt neben dem FVRC-Workspace auch den generischen `workspaceId` atomar auf den Ziel-Workspace und bleibt damit nach Reload oder Routenwechsel reproduzierbar. Web-Clients leiten den Link immer aus den typisierten IDs ab und vertrauen keinem gelieferten `deepLink`. Ein Widerspruch zwischen dem Workspace des Inbox-Eintrags und dem Target faellt auf die Workspace-Route ohne Review-Auswahl zurueck.

## Trust-, Race- und Read-State-Grenze

Ein URL-Parameter kann niemals die Quelle `notification` erzeugen: jeder V1-Deep-Link wird als `deep_link` geparst. Nur der echte Bell- oder Home-Klick erzeugt einen nicht serialisierten In-Memory-Intent, der an Request-Generation, Workspace, Lineage und Operation gebunden ist. Der Host beansprucht diesen Intent erst, wenn genau diese Operation im genau passenden Timeline-Dokument sichtbar ausgewaehlt wurde. Erst dann wird der bestehende Inbox-PATCH zum Gelesen-Markieren ausgefuehrt.

Erfolgreich beanspruchte Tupel bleiben bis zum Schliessen, einem neuen echten Notification-Intent oder dem bewussten Wechsel von der initialen Operation gesperrt. Ein PATCH-Fehler gibt denselben Intent fuer einen spaeteren echten Retry frei. Access denied, missing/stale selection, falscher Workspace, falsche Lineage und URL-Spoofing loesen keinen Read-State aus. Wird eine Operation zwischen Inbox-Laden und Center-Aufloesung ungueltig, zeigt der Center seinen bestehenden fail-closed Fehler und fordert eine Summary-Aktualisierung an, ohne die Notification als gelesen zu quittieren.

Schnelle konkurrierende Klicks besitzen eine eigene Generation. Nur der neueste Klick darf Workspace, Center und Auswahl festlegen. Der Notification-Oeffner ist dabei alleiniger Owner des direkten Workspace-Wechsels: Er publiziert weder `workspaceId` noch FVRC-State oder Review-URL, bevor `setActiveWorkspace` erfolgreich abgeschlossen ist. Dadurch kann der global montierte `WorkspaceNavigationSync` nicht ueber denselben transienten Ziel-Link einen zweiten konkurrierenden Switch starten. Scheitert der Wechsel, bleiben aktiver Workspace, Ausgangs-Link und Center-State unveraendert; auch ein spaet abschliessender ueberholter A-Klick kann nach einem fehlgeschlagenen B-Klick keinen inkonsistenten Zustand hinterlassen.

Die reale Browserabnahme deckte zusaetzlich eine Luecke zwischen Store-Commit und URL-Publikation auf: In diesem kurzen Fenster konnte `WorkspaceNavigationSync` noch den alten Workspace-Request als ueberholt aufraeumen. Ein gezaehlter, immer im `finally` freigegebener In-Memory-Guard kennzeichnet nun genau diesen extern gesteuerten Wechsel. Er verhindert weder die spaetere Annahme des neuen Request-Keys noch erweitert er die URL-Vertrauensgrenze. Der permanente Integrationstest verzoegert jetzt auch explizit nach dem bereits erfolgten Workspace-Commit und belegt, dass weder Ausgangs-Link noch Center-State vorzeitig veraendert oder geloescht werden.

## Exakte Query-Auswahl

Die initiale Resolve-Abfrage reicht `selectedEntry` bis zum Query-Service weiter. Eine angeforderte, noch zulaessige Agentenoperation wird unabhaengig von Alter und erstem Seitenlimit an Position eins gepinnt und auf Folgeseiten nicht dupliziert. Der Cursor behaelt die Ausschluss-ID innerhalb des bestehenden V1-Limits. Tests mit mehr als 25 Reviews belegen terminierende Pagination ohne Verlust, Duplikat oder Ordnungsdrift.

Damit kann auch eine fehlgeschlagene direkte Anwendung aus FVRC-800 exakt inspiziert werden. Sie bleibt `actionsAllowed: false` und zeigt keine Accept-/Reject-Schleife. Fremde Initiatoren ohne Managerrecht, andere Workspaces oder Lineages, archivierte Dokumentgenerationen, `persistence_degraded`, erfolgreich supersedierte und inzwischen aufgeloeste Operationen enden fail-closed als stale oder access denied. Manipulierte Cursor werden abgewiesen.

## Mobile- und Native-Grenze

FVRC-801 umfasst responsive Web-Oberflaechen und den versionierten Mobile-API-Vertrag. Mobile Clients erhalten `file_change`, `deepLink` und `fileChangeReason` weiterhin nur nach dem in FVRC-800 eingefuehrten Opt-in `capability=inbox.file_changes.v1`; Bootstrap und Legacy-Kompatibilitaet bleiben gruen. Der Link verweist auf denselben globalen Web-Center und dieselbe exakte Operation.

Ein separater nativer Review-Center oder eine native Navigation ist bewusst kein Bestandteil dieses Meilensteins. Das bleibt ein eigener Mobile-Meilenstein mit Real-Device-Gate; FVRC-801 erhebt ohne diesen Gate keinen Claim fuer einen nativen Client.

## Fokussierte Verifikation

- `npm run test:file-version-center:notifications`: Source-, Mobile-Compatibility-, Mobile-Bootstrap-, Home- und NotificationBell-Tests bestanden.
- `npm run test:file-version-center:notifications:integration`: echter HTTP-/PostgreSQL-Smoke bestanden; Desktop-Summary, Mobile Single/Aggregate/Badge, Capability-Isolation, PATCH-Routen und vollstaendige State-Wiederherstellung waren erfolgreich.
- `npm run test:file-version-center:hardening`: Deep-Link-Spoofing, exact open/ack, Workspace- und Click-Races, Pagination, stale/denied, failed-direct, Routen-, Restore-, Compare-, Timeline-, Action- und Tool-App-Hardening bestanden. Der integrierte Sync-Test montiert den echten `WorkspaceNavigationSync`, verwendet den echten Workspace-Store-Switch und verzoegert sowohl `prepareCurrentFileForTransition` als auch die Rueckkehr nach bereits erfolgtem Workspace-Commit; Pending, Failure, A/B-Out-of-order und fehlgeschlagenes B bleiben workspacekonsistent und ohne zweiten Sync-Switch.
- Editor-, Dateibrowser-, Home-, Chat-Navigation-, Collaboration-Approval- und File-Change-Tool-App-Regressionen bestanden.
- Der freigegebene echte Playwright-Lauf gegen den frisch gebauten Stack pruefte Bell und Home, exakte Operation/Lineage/Workspace-Auswahl, Cross-Workspace-Wechsel, `unread -> sichtbar ausgewaehlt -> read`, Reload ohne zweiten Read-State, fehlgeschlagene Direktanwendung ohne Accept/Reject, das vor dem Center geschlossene mobile Notification-Sheet sowie 1600 x 900, 760 x 900 und 390 x 844 mit Touch. Ein separater Dark-Start-Kontext pruefte Dark Mode und Reduced Motion vor dem ersten Render.
- Die vorhandene P701-Timeline-Loesung misst im echten Browser links und rechts jeweils 16 px fuer Current- und History-Karten. Der Radix-Viewport hat in allen drei Viewports `scrollWidth === clientWidth`, Selected-/Focus-Ringe liegen innen und die Seite besitzt keinen horizontalen Overflow. Der zuerst gemeldete asymmetrische Stand war ein waehrend des Container-Recreates im Browser gehaltener Alt-Bundle; nach echtem Reload war keine weitere CSS-Aenderung erforderlich.
- `npm run lint`, `npx tsc --noEmit --pretty false` und `git diff --check`: bestanden.

## Browser-Evidence

- `01-bell-exact-open-desktop-light.png`, `02-home-exact-open-desktop-light.png`, `04-successful-open-read.png` und `05-reload-deep-link.png` belegen die beiden Einstiege, exakte Auswahl, Gelesen-Grenze und Reload.
- `03-home-sheet-mobile.png` belegt den geschlossenen Home-Sheet und den anschliessend sichtbaren globalen Center bei 390 x 844 mit Touch.
- `06-cross-workspace.png` belegt identische generische und FVRC-Workspace-Ziele nach dem Wechsel aus einem anderen autorisierten Workspace.
- `09-direct-apply-failed.png` belegt den roten fehlgeschlagenen Vorschlag mit `actionsAllowed: false` und ohne Accept-/Reject-Steuerung.
- `10-timeline-gutter-desktop.png`, `11-timeline-gutter-760.png` und `12-timeline-gutter-mobile.png` belegen die symmetrischen Kartenfluchten.
- `13-bell-exact-open-desktop-dark.png` belegt den vor dem ersten Render aktivierten Dark Mode mit Reduced Motion.

## Abschluss-Gate

Der verwaltete Host- und Docker-Produktionsbuild bestand mit 344 Seiten und TypeScript. Fuer die bekannte lokale `/sign-up`-Prerender-Baseline wurde ausschliesslich waehrend des Builds ein nicht committeter `force-dynamic`-Flag gesetzt und unmittelbar nach dem Recreate entfernt. Der einzelne Team-Seat-Stack enthaelt exakt vier gesunde Dienste: Notebook, PostgreSQL 18.4 mit pgvector sowie Control-Plane API und Web. Nach der Browserabnahme wurden alle `fvrc-801-browser-*`-Operationen und zugehoerigen Read-State-Fixtures entfernt; beide Restzaehler sind null. FVRC-801 und das Gate FVRC-G08-NOTIFICATIONS sind abgeschlossen.
