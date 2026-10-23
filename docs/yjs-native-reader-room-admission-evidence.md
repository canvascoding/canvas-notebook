# Native Reads und Aufnahme in den Editor

Stand: 2026-10-14. Enger Produktfix auf Basis `a5f4160b8b1e23396df780f025e1ffbabd533efb`; der [vorherige Browserbefund](./yjs-editor-join-authentication-evidence.md) bleibt unverändert erhalten. Seine genaue blockierende SQL-Session ist nicht nachträglich nachgewiesen.

## Belegter Konflikt und Korrektur

Der [native Reader](../app/lib/collaboration/workspace-native-file-read.ts) hält während seines Callbacks einen tatsächlichen gemeinsamen Workspace-Admission-Lock. Die bisherige [Owneraufnahme](../app/lib/collaboration/room-owner.ts) fordert auf demselben Schlüssel einen exklusiven, nicht blockierenden Lock an. Ein separat gehaltener Metadatenread reicht deshalb aus, um einen berechtigten neuen Ownerclaim mit `ROOM_OWNER_BUSY` abzulehnen. Der neue echte PostgreSQL-Reproducer bestätigt diesen Konflikt auf dem alten Produktstand. Das ist ein eigener reproduzierbarer Fehler; die zeitliche Nähe im ursprünglichen V17-Trace beweist dessen konkreten Lockhalter nicht.

Der neue [Room-Admission-Helfer](../app/lib/collaboration/file-lifecycle-writer-admission.ts) erlaubt gemeinsame Admission ausschließlich für Text-Roomjoins und kurze Ownerclaims. Die [private WebSocket-Prüfung](../server/collaboration-server.ts) verwendet ihn; Excalidraw behält seinen bisherigen exklusiven Pfad. Die zwei bisherigen Writerhelper, die private Direct-Prüfung und alle drei Direct-Aufrufstellen bleiben bytegleich. Der native Reader wird nicht verändert.

Aktive Reservierungen werden weiterhin geprüft. Der separate Dokument-Ownerlock bleibt exklusiv und nicht blockierend; die gesperrte SQL-Zeile muss weiterhin zur exakten Dokumentidentität passen. Eine echte geerbte Lifecycle-Schreibfreigabe bleibt nur innerhalb ihrer geprüften Lease gültig. Es gibt keinen Busy-Retry, keine Warteoperation unter dem Room-/Kernel-Lock und keine Erweiterung von Benutzerrechten. Native Inhaltsbytes, Vektor, Sequenz, Generation und Repräsentation werden durch den Fix nicht umgeschrieben.

## Tatsächliche lokale Prüfung

Die [neue isolierte PG18-Matrix](../scripts/native-read-room-owner-admission-postgres-test.ts) verwendet reale Reader-/Owner-/Admission-Services und separate echte Backends. Auf dem alten Stand bestehen acht Schutzgruppen; ausschließlich der unveränderte positive Reader-/Ownerfall scheitert mit `ROOM_OWNER_BUSY`, Exit 1. Mit dem Fix und identischen Testbytes bestehen alle neun Gruppen. Root wiederholt diesen vollständigen Lauf nach Integration unabhängig, Exit 0.

Geprüft sind exklusive physische Admission, echte Lifecycle-Lease mit gültiger und abgelaufener scoped Freigabe, tatsächlich committed Reservierung, fremder Owner, sechs Identitätsänderungen, Verlust des eigenen Backends, COMMIT-/Reservierungsreihenfolge, unveränderte exklusive Directwriter und der gleichzeitig gehaltene Metadatenread. Die Reihenfolgeprüfung belegt, dass eine spätere Reservierung erst den committed Owner mit exaktem Epoch-/Token-/Backendbezug erfasst. Die neue Backendverlustgruppe schließt ihren eigenen Client; sie behauptet keinen zusätzlichen erzwungenen Backend-Kill. Die Cleanup prüft geschlossene eigene Clients und entfernt ausschließlich ihr zufälliges Schema und ihre temporäre DATA-Wurzel.

Root bestätigt außerdem die bestehenden Owner-, Release- und Lifecycle-Writer-Prüfungen auf tatsächlichem PostgreSQL ohne Skip sowie Session-, Admission-, Release-, Activity-, Runtime- und beide Servermatrices. Die erweiterten Serverfixtures beobachten tatsächlich erreichte gemeinsame WS- und exklusive Direct-Lockqueries. Vollständiges TypeScript mit 8 GiB, fokussiertes ESLint und Diffcheck bestehen. Die unabhängige Source-Review meldet keine materiellen Befunde.

Dieser Nachweis aktiviert keine weiteren nativen Session-, Migrations-, Dateioperations- oder Undo-Bausteine. Die vollständige unveränderte Browsermatrix mit Create/Paste/Import, Fokus/Breite, Links und beiden Hostneustartfällen muss auf einem frisch gebauten integrierten Stand noch bestehen. §13.3 des [Masterplans](./yjs-document-authority-consolidation-plan.md) und die Produktionsabnahme bleiben gesondert offen.
