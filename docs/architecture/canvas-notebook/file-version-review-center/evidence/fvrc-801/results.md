# FVRC-801 Notification-entry evidence

Datum: 15. September 2026

## Implementierter Umfang

NotificationBell und Home oeffnen eine `file.change_review_required`-Notification im selben Fenster im einen globalen File Version Center. Beide Einstiege verwenden das vorhandene `FileClock`-Icon sowie zustandsspezifische deutsche und englische Texte fuer `needs_review`, `partially_applied`, `semantic_conflict` und `direct_apply_failed`. Home behaelt den Workspace-Namen in der sichtbaren Statuszeile; das responsive Notification-Sheet schliesst kontrolliert, bevor der Center geoeffnet wird.

Der datenminimierte Link enthaelt nur Workspace, Lineage und Agentenoperation. Er setzt neben dem FVRC-Workspace auch den generischen `workspaceId` atomar auf den Ziel-Workspace und bleibt damit nach Reload oder Routenwechsel reproduzierbar. Web-Clients leiten den Link immer aus den typisierten IDs ab und vertrauen keinem gelieferten `deepLink`. Ein Widerspruch zwischen dem Workspace des Inbox-Eintrags und dem Target faellt auf die Workspace-Route ohne Review-Auswahl zurueck.

## Trust-, Race- und Read-State-Grenze

Ein URL-Parameter kann niemals die Quelle `notification` erzeugen: jeder V1-Deep-Link wird als `deep_link` geparst. Nur der echte Bell- oder Home-Klick erzeugt einen nicht serialisierten In-Memory-Intent, der an Request-Generation, Workspace, Lineage und Operation gebunden ist. Der Host beansprucht diesen Intent erst, wenn genau diese Operation im genau passenden Timeline-Dokument sichtbar ausgewaehlt wurde. Erst dann wird der bestehende Inbox-PATCH zum Gelesen-Markieren ausgefuehrt.

Erfolgreich beanspruchte Tupel bleiben bis zum Schliessen, einem neuen echten Notification-Intent oder dem bewussten Wechsel von der initialen Operation gesperrt. Ein PATCH-Fehler gibt denselben Intent fuer einen spaeteren echten Retry frei. Access denied, missing/stale selection, falscher Workspace, falsche Lineage und URL-Spoofing loesen keinen Read-State aus. Wird eine Operation zwischen Inbox-Laden und Center-Aufloesung ungueltig, zeigt der Center seinen bestehenden fail-closed Fehler und fordert eine Summary-Aktualisierung an, ohne die Notification als gelesen zu quittieren.

Schnelle konkurrierende Klicks besitzen eine eigene Generation. Nur der neueste Klick darf Workspace, Center und Auswahl festlegen. Der Notification-Oeffner ist dabei alleiniger Owner des direkten Workspace-Wechsels: Er publiziert weder `workspaceId` noch FVRC-State oder Review-URL, bevor `setActiveWorkspace` erfolgreich abgeschlossen ist. Dadurch kann der global montierte `WorkspaceNavigationSync` nicht ueber denselben transienten Ziel-Link einen zweiten konkurrierenden Switch starten. Scheitert der Wechsel, bleiben aktiver Workspace, Ausgangs-Link und Center-State unveraendert; auch ein spaet abschliessender ueberholter A-Klick kann nach einem fehlgeschlagenen B-Klick keinen inkonsistenten Zustand hinterlassen.

## Exakte Query-Auswahl

Die initiale Resolve-Abfrage reicht `selectedEntry` bis zum Query-Service weiter. Eine angeforderte, noch zulaessige Agentenoperation wird unabhaengig von Alter und erstem Seitenlimit an Position eins gepinnt und auf Folgeseiten nicht dupliziert. Der Cursor behaelt die Ausschluss-ID innerhalb des bestehenden V1-Limits. Tests mit mehr als 25 Reviews belegen terminierende Pagination ohne Verlust, Duplikat oder Ordnungsdrift.

Damit kann auch eine fehlgeschlagene direkte Anwendung aus FVRC-800 exakt inspiziert werden. Sie bleibt `actionsAllowed: false` und zeigt keine Accept-/Reject-Schleife. Fremde Initiatoren ohne Managerrecht, andere Workspaces oder Lineages, archivierte Dokumentgenerationen, `persistence_degraded`, erfolgreich supersedierte und inzwischen aufgeloeste Operationen enden fail-closed als stale oder access denied. Manipulierte Cursor werden abgewiesen.

## Mobile- und Native-Grenze

FVRC-801 umfasst responsive Web-Oberflaechen und den versionierten Mobile-API-Vertrag. Mobile Clients erhalten `file_change`, `deepLink` und `fileChangeReason` weiterhin nur nach dem in FVRC-800 eingefuehrten Opt-in `capability=inbox.file_changes.v1`; Bootstrap und Legacy-Kompatibilitaet bleiben gruen. Der Link verweist auf denselben globalen Web-Center und dieselbe exakte Operation.

Ein separater nativer Review-Center oder eine native Navigation ist bewusst kein Bestandteil dieses Meilensteins. Das bleibt ein eigener Mobile-Meilenstein mit Real-Device-Gate; FVRC-801 erhebt ohne diesen Gate keinen Claim fuer einen nativen Client.

## Fokussierte Verifikation

- `npm run test:file-version-center:notifications`: Source-, Mobile-Compatibility-, Mobile-Bootstrap-, Home- und NotificationBell-Tests bestanden.
- `scripts/file-version-center-contract-test.ts`, `file-version-center-open-test.tsx`, `file-version-center-notification-workspace-sync-test.tsx`, `file-version-center-query-test.ts`, `file-version-center-timeline-test.tsx` und `file-version-center-actions-test.tsx`: Deep-Link-Spoofing, exact open/ack, Workspace- und Click-Races, Pagination, stale/denied und failed-direct bestanden. Der integrierte Sync-Test montiert den echten `WorkspaceNavigationSync`, verwendet den echten Workspace-Store-Switch und verzoegert `prepareCurrentFileForTransition`; URL und FVRC-State bleiben waehrend Pending und nach Failure unveraendert, A/B-Out-of-order sowie fehlgeschlagenes B bleiben workspacekonsistent und ohne zweiten Sync-Switch.
- Editor-, Dateibrowser-, Home-, Chat-Navigation-, Collaboration-Approval- und File-Change-Tool-App-Regressionen bestanden.
- Die vorhandene P701-Timeline-Loesung prueft im Komponententest den symmetrischen 16-px-Gutter (`p-4`) sowie den blockweiten Radix-Viewport-Wrapper. Auf Basis des als stale erkannten laufenden Containers wurde bewusst keine zweite CSS-Korrektur eingefuehrt.
- `npm run lint`, `npx tsc --noEmit --pretty false` und `git diff --check`: bestanden.

## Noch ausstehende Gates

FVRC-801 bleibt bis zur zentral koordinierten Abnahme `in_progress`. Root fuehrt den vorgeschriebenen Build, den einzigen frischen verwalteten Team-Seat-Container sowie die freigegebenen UI/E2E-Pruefungen aus `qa-inventory.md` aus. Insbesondere werden Light/Dark, 760 px, 390 px, der reale Workspace-Wechsel und der Timeline-Gutter erst gegen den frisch recreateten Stand abschliessend behauptet.
