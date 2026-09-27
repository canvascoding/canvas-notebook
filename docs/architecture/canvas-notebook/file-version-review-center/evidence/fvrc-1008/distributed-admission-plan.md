# Prozessübergreifende Lifecycle-Zulassung: nächster Umsetzungsschritt

Stand: 27. September 2026, nach `cfb45166c`. **Plan, noch nicht implementiert.**
Fortsetzung des [lokalen terminalen Drains](terminal-room-drain-results.md),
Teil von FVRC-1008. Keine Aktivierung, kein P12-Abschluss und keine Mergefreigabe.

## Zweck und aktueller Befund

Zwischen dem finalen Store des bisherigen Owners und einem Lifecycle-Commit
darf kein anderer Prozess das Dokument erneut als Live-Raum beanspruchen.
Der jetzige lokale Drain reicht dafür nicht: Nach seiner Freigabe kann ein
anderer PostgreSQL-Client den Owner-Advisory-Lock erwerben. Eine lokale leere
Room-Map oder `room_owner_token = NULL` ist keine dauerhafte Autorisierung.

Vorhanden sind der gefencete Owner-Claim, der vollständige Release-Beleg und
der lokale Drain. `reserveCollaborationRoomAdmission` ist dagegen lediglich
ein prozesslokaler Beleg mit Timeout; es ist keine verteilte Reservation.
Die bisherige Lifecycle-Prüfung in `lockUnchangedLifecycleSnapshot` verweigert
Owner-Epochen größer null bewusst weiter. Diese Prüfung wird nicht gelockert,
bevor die komplette Übergabe nachgewiesen ist.

## Verbindliche Invarianten

1. Dauerhafte Reservation **vor** Workspace-/Pfadlocks anlegen. Neue Claims
   prüfen dieselbe Reservation atomar mit ihrem Scope-/Epoch-Update.
2. Der bestehende Owner behält seinen gültigen Fence bis zum finalen Store.
   Die Reservation darf ihn nicht vorzeitig invalidieren.
3. Beim Warten auf den Owner keine Workspace-, Room-, Save- oder SQL-Zeilenlocks
   halten. Der Owner benötigt diese selbst zum Abschließen zugelassener Arbeit.
4. Nach bewiesener Freigabe denselben Owner-Advisory-Lock auf einer dedizierten
   Sitzung übernehmen und bis zum bestätigten Lifecycle-Ergebnis halten.
   Ein neu erworbener Lock allein beweist keinen vollständigen finalen Store.
5. Ein separater Workspace-Admission-Transaktionsguard ordnet Reservation,
   Scope-Überlappung und Claim, einschließlich noch nicht vorhandener Targets.
   Dokumentzeilen ordnen die jeweilige Epoch-/Scope-Änderung. Kein blockierendes
   Warten auf Owner-Advisory-Locks unter Admission- oder Dokumentzeilensperren.
6. Request-ID, vollständiger Scope, Aktionsdigest, Antragsteller und Owner-Epoch
   binden Wiederholungen. Gleiche ID mit anderem Auftrag ist kein Retry.
7. Keine Freigabe durch TTL, Heartbeat-Ausfall oder bloßen Prozessneustart.
   Ungewisse COMMITs brauchen einen positiven gespeicherten Ergebnisbeleg.
8. Alte/mischende Server dürfen das Protokoll nicht umgehen. Aktivierung bleibt
   ein eigenes Fleet-Gate, nicht nur ein zusätzliches Schemafeld.

## Sequenzielle To-Dos

### DA-01 – Persistenter Reservation-Vertrag und Claim-Race

- Additives Schema für Request, Quell-/Ziel-Pfadbereiche, exakte Dokumentmenge,
  gebundene Ausgangsscopes, Aktionsdigest und CAS-Status entwerfen. Pro Dokument
  und überlappendem reservierten Bereich darf höchstens ein aktiver Request
  existieren; abgeschlossene Belege bleiben idempotent lesbar.
- Kurze SQL-Transaktion zur Reservation verwenden: domänengetrennter
  Workspace-Admission-Xact-Guard, Überlappung prüfen, betroffene Dokumente in
  stabiler Reihenfolge sperren, Scope und Owner erfassen, Request committen.
  Cross-Workspace-Guards stets in derselben stabilen Reihenfolge erwerben.
- Owner-Claim nutzt denselben Admission-Guard vor Reservation-Check,
  **nicht blockierendem** Owner-Try-Lock und Dokumentzeilenprüfung. Sonst können
  neue Dokumente oder leere Zielbereiche die reine Dokumentreservation umgehen.
  Ein verweigerter Ersatz-Claim setzt die bisherige Epoch nicht zurück.
- Bestehender Owner-Store und Release werden durch die Reservation nicht
  blockiert; ihr exakter Fence und ihre normalen Datenprüfungen bleiben Pflicht.
- Initial nur separat testbare Mechanik, keine Domain- oder Runtime-Aktivierung.
- Bei verlorener Reserve-COMMIT-Antwort Verbindung zuerst verwerfen und den
  exakten Request auf frischer Verbindung nachweisen; kein neuer Zufalls-Retry.
  Fehlt der Datensatz nach bestätigtem Schließen der alten Verbindung, darf
  ausschließlich dieselbe Request-ID mit identischem Digest/Scope erneut
  reservieren. Kein kompensierendes Löschen eines ungewissen Requests.

Abnahme: echte getrennte PostgreSQL-Backends für Claim-vor-Reservation und
Reservation-vor-Claim, konkurrierende Reservationsaufträge, verlorene
COMMIT-Antwort, falscher Scope/Digest und erfolgreicher Claim nach nachweisbar
abgeschlossenem Request. Nur Ablehnung zu testen genügt nicht.

### DA-02 – Owner-Benachrichtigung und exakter Drain-Auftrag

- Dauerhafter Request ist die Wahrheit; Benachrichtigungen wecken nur auf.
  Doppelte oder verlorene Nachrichten müssen ungefährlich sein.
- Auftrag an erwarteten Owner-Token/Epoch/Backend und Scope binden. Der heutige
  rein scopegebundene lokale Handler muss dafür erweitert werden; eine verspätete
  Nachricht darf keinen inzwischen übernommenen Raum schließen.
- Startup-, Direct-, Peer-, Reader- und Reconciliation-Aktivitäten wie im
  lokalen Drain wirklich auslaufen lassen, final speichern, Receipt zuordnen.
- Receipt, exakten Owner-Token-Clear und Bestätigung des gebundenen
  Reservation-Targets in derselben Owner-Transaktion committen, bevor der
  Session-Advisory-Lock freigegeben wird. Das Target referenziert/pinnt seinen
  Receipt; auch der jüngste Beleg der aktuellen tokenlosen Epoch darf nicht
  zwischen Release und späterer Prüfung durch Retention verschwinden.
- Nach positivem Release und fehlgeschlagenem lokalem Unload eine wiederaufnehmbare
  Abschlussphase vorsehen, statt den einzigen Handle unwiederbringlich zu verlieren.

Abnahme: wiederholte/verlorene Benachrichtigung, falsche Epoch, parallel laufender
Startup, bereits laufendes normales Unload, Drain-Fehler und erfolgreicher Retry.

### DA-03 – Leere Räume und Wiederanlauf ausdrücklich behandeln

- Bereits vor dem Request normal entladene Räume haben bisher keinen terminalen
  Release-Beleg. Normales Unload muss künftig ebenfalls den unveränderlichen
  finalen Snapshot mit einem Receipt freigeben; nicht nachträglich aus Token-null
  einen Beleg erfinden. Für bisher nie beanspruchte Epoch-0-Räume ist ein eigener
  Vacant-Proof unter gehaltenem Room-Guard plus exakter gesperrter Zeile nötig.
  Dieser ist kein Nachweis für die Sicherheit gleichzeitig laufender Altserver.
- Normaler Release-Beleg nie in einem noch abbrechbaren `beforeUnload`-Hook:
  erst einen owner-kontrollierten, nicht mehr abbrechbaren Abschluss nach
  erfolgreichem finalem Store schaffen. Bei Fehler kein erfolgreicher Unload;
  der bisherige snapshotlose `release()` bleibt ausdrücklich kein Beleg.
- Noch ladende Räume können vor oder nach dem Reserve-COMMIT claimen. Beide
  Reihenfolgen müssen durch DA-01/02 eindeutig in Ablehnung oder Drain münden.
- Bei verlorenem Owner mit altem Token bleiben unbestätigte Änderungen und
  lokale/Peer-Recovery erhalten. Keine automatische Generationserhöhung zum
  Verwerfen dieser Änderungen und kein blindes Wiederanwenden alter Bytes.
- Recovery nach Reserve-COMMIT, Release-COMMIT und vor/nach lokalem Destroy
  getrennt definieren. Abbruch vor einer Mutation und ungewisse Mutation sind
  verschiedene Fälle; letzterer öffnet keine Zulassung ohne Ergebnisnachweis.
- Session-/Guard-Verlust hält die Reservation im aktiven Recovery-Zustand.
  Timeout und Restart setzen sie nicht automatisch auf abgeschlossen.

Abnahme: normaler Unload vor Request, Owner-Absturz ohne Receipt, gültiges Receipt
mit fehlendem Finish, neue Serviceinstanz und danach tatsächliche Weiterarbeit.

### DA-04 – Gehaltener Übergabe-Guard bis zum Lifecycle-Ergebnis

- Dedizierte PostgreSQL-Sitzung hält die betroffenen Owner-Advisory-Locks in
  stabiler Reihenfolge; try-only Erwerb, kontrollierter Neuversuch außerhalb
  nachgelagerter Sperren und keine Pool-Rückgabe zwischen Prüfung und Mutation.
- Request, Receipt, Scope und gespeicherte Bytes unter den erforderlichen
  Sperren erneut prüfen. Fehlender Receipt bleibt ein eigener Recoveryfall.
- Ein wartender Claim darf hier keine umgekehrte Sperrreihenfolge erzeugen:
  Unter dem Admission-Xact-Guard ausschließlich Owner-**Try**-Lock, niemals
  auf den bereits vom Coordinator gehaltenen Owner-Lock warten. Alle später
  ergänzten Admission-/Footprint-Prüfungen müssen diese Ordnung einhalten.
- Erst danach Workspace-/Pfadsperren und kurze Mutationstransaktion erwerben.
  Frische Rechte und fachliche Vorbedingungen bleiben Aufgabe des Aufrufers.
- Die vollständige Ordnung lautet: aktive Reservation → stabile Room-Guards →
  Workspace → Pfad-Xact-Locks → Operationszeilen → Zustandszeilen → atomarer
  Outcome-/Reservationscommit. Wird zur Terminalisierung zusätzlich der
  Admission-Guard benötigt, sehen Claims vorher die aktive Reservation und
  versuchen keinen Room-Lock; nach Terminalisierung bleibt jeder Claim try-only.
- Mutationsbeleg und Request-Abschluss soweit SQL-basiert atomar speichern;
  Dateiprojektion und nicht atomare Dateisystemschritte ausdrücklich über den
  vorhandenen Journal-/Recovery-Vertrag absichern, nicht als SQL-atomar ausgeben.
- Bei ungewissem Commit alte Verbindung beenden und exakten Beleg wiederfinden.
  Locks und Reservation nicht aufgrund eines verschluckten Fehlers freigeben.

Abnahme: konkurrierender Neu-Claim zwischen Release und Commit, Sessionverlust
während Mutation, Commit-Antwortverlust sowie idempotenter Nachlauf ohne
Doppelwirkung und ohne verlorene unabhängige Änderungen.

### DA-05 – Domain-Aufrufer einzeln umstellen

- Äußerste Eintrittspunkte für Rename/Move, Delete/Archive, Restore, Copy mit
  existierendem Ziel, Repräsentationswechsel und Kompaktierung auditieren.
  Ein Einstieg erst innerhalb von `collaboration-policy.ts` wäre zu spät,
  wenn ein äußerer Aufrufer bereits den Workspace-Lock hält.
- Quell- **und Zielpfadbereiche unabhängig von aktueller Existenz** reservieren,
  bei Ordnern jeweils den ganzen Subtree. Overwrite/Restore bindet zusätzlich
  bestehende Dokument-IDs; Restore auch die exakte archivierte Generation über
  `trashEntryId`/Lineage. Vorab erzeugte Backup-/interne Zielpfade gehören ebenfalls
  in den Scope. Cross-Workspace-Locks haben eine stabile Reihenfolge.
- Pfadscopes kanonisch und segmentweise vergleichen, nicht über unsichere
  Stringpräfixe. Alle Neuanlagen von Collaboration-Dokumenten und alle neuen
  Agentenoperations-Zulassungen müssen vor Aktivierung dieselben aktiven Scopes
  prüfen. Bereits zugelassene Arbeit muss dagegen ihren finalen Store weiterhin
  beenden können. Sonst bleiben insbesondere vorher leere Ziele ungeschützt.
- Dokumentmenge nach Erwerb der Workspace-/Pfadsperren neu prüfen. Bei neuen,
  nicht reservierten Dokumenten Sperren freigeben und kontrolliert neu planen;
  niemals unter dem Workspace-Lock noch einen fehlenden Owner drainen.
  Das Requery ist zusätzliche Absicherung, kein Ersatz für die Admission-Prüfung
  sämtlicher neu anlegender oder neu zulassender Writer.
- Jeweils genau einen Domainpfad integrieren, inklusive Dateisystem-/SQL-
  Fehlerpfaden testen und committen, bevor der nächste umgestellt wird.

### DA-06 – Mehrprozess-/Recovery-Gate vor Aktivierung

- Zwei echte App-/OS-Prozesse an getrennten PostgreSQL-Verbindungen verwenden,
  nicht lediglich zwei Serviceinstanzen oder eine simulierte Room-Map.
- Isolierte Testdaten am vorhandenen verwalteten Stack; keine zweite
  Containerumgebung und kein Containerneubau ohne Freigabe.
- Prozessabbrüche an den oben definierten Grenzen, Reconnect/Offline-Caches,
  Rechteentzug und konkurrierende Nutzeränderungen prüfen.
- Erfolgreiche Fortsetzung nach Recovery belegen; Quarantäne allein ist kein
  grüner Nutzbarkeitstest. Personal/Team und echte UI-/Browserpfade einbeziehen.
- Danach erst regulären Bootstrap und sämtliche Binärschreiber gemeinsam
  aktivieren. Atomarer Kandidatencommit vor Live-Publish, Gesamtmatrix und P12
  bleiben eigenständige nachfolgende Gates.

## Nächster Commitumfang

DA-01 ist der nächste Codebaustein: Schema, kurze Reservation-Transaktion,
atomare Claim-Sperre und reale PostgreSQL-Race-/Recoverytests. DA-02 bis DA-06
werden dadurch weder implementiert noch freigegeben. Das vermeidet eine
vorzeitige Lockerung der bestehenden Schutzprüfungen.
