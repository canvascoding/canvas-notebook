# Gemeinsame Drain-Mechanik für native Dateiaktionen

Stand: 19. Oktober 2026. Grundlage ist Root `3a53cce99231a2bbd1f301b6c6b026f287d58bf2`. Dieser Schritt schafft wiederverwendbare Mechanik; er verbindet noch keinen neuen Live-Editor-Dateiaktionspfad und behebt den ursprünglichen Produktionsfehler nicht.

## Änderung und Grenzen

`startCollaborationAdmissionDrainOnConnection` enthält die bisherige unveränderte Request-/Target-/Ticket-Transition. Der bestehende Admission-Dienst behält Vorvalidierung, Transaktion und verlorene-COMMIT-Recovery. Der neue Helper besitzt weder Verbindung noch Transaktion, Berechtigung oder Wartephase. Ein reiner Move-Bundledecoder und ein Requesthelper aus genau diesem geprüften Bundle erhalten die bisherigen Requestbytes und die gespeicherte V2-Witnessprüfung. Ein zusätzlicher Runner-Eintrag führt die vorhandene Move-V2-Suite als echten ESM-Quellgraph aus.

GitNexus meldet für den Admission-Dienst HIGH, 28 direkte Aufrufer; die Warnung wurde vor Integration ausgegeben. Die neuen Namen sind noch nicht indexiert und haben UNKNOWN-Abdeckung. Die vollständige Vorbereitung vor Drain benötigt zusätzlich dauerhafte Witnessdaten; die bestehende Admission-/Bundle-Speicherung enthält sie nicht vollständig. Dieser Speicher und der tatsächliche Claim-/Owner-/B2-Anschluss sind hier noch nicht integriert.

## Tatsächliche Prüfungen

Private Originalprotokolle: `/private/tmp/canvas-native-path-admission-8gusy9ys/`.

- Bestehender Original-Move-Vertrag sowie Admission-, Drain- und Worker-Verträge: jeweiliger tatsächlicher Exit 0.
- Bestehende Move-V2-Suite über echten ESM-Quellgraph: 11/11, Exit 0. Erhalten bleiben strikte Beforeclocks, semantischer Witness, Originalattribution und die historischen Intentformate.
- Bestehende tatsächliche PG18-Drain-Suite: 10 Prüffälle, Exit 0; einschließlich verlorener Start-/Release-COMMIT-Bestätigungen und gemischter Targets.
- Bestehende tatsächliche PG18-Quiescence-Suite: 18 Prüffälle, Exit 0; einschließlich Ownerkonkurrenz, exakter Bytes, alter Migration und Recovery.
- Gezielte TypeScript- und Lintprüfung: Exit 0. Die Testcontroller bestätigen unveränderte drei Produktquellen während der jeweiligen Läufe.

Die allgemeine ältere Reservation-PG-Suite scheitert mit Exit 1 an `Claim-first reservation never opened its PostgreSQL backend.` Die separat ausgeführte unveränderte Vorversion von `room-admission.ts`, SHA-256 `ba8833bee47bfba92541d97299815b54310fb7ec598cb6b61e9259d7d72d2535`, scheitert als tatsächlicher ESM-Quellgraph an genau derselben Stelle. Bereits der Ausgangscode nimmt den Workspace-Kernellock vor dem Checkout; der ältere Test erwartet während des gehaltenen Owner-COMMIT-Gates eine PG-Verbindung. Die Prüfung bleibt fehlgeschlagen und ist keine neue grüne Gesamtabnahme. Der erste private Baseline-Runner scheiterte zuvor beim Bundling; auch sein Originalprotokoll bleibt erhalten.

Der erste direkte TSX-Aufruf der Move-V2-Suite scheiterte vor Testausführung am vorhandenen CommonJS-Packageexport `@earendil-works/pi-ai/compat`; der echte ESM-Runner löst diese Ausführungsgrenze. Weder dieser fehlgeschlagene Vorlauf noch die Reservation-Suite werden als bestanden gezählt.

## Weiter erforderlich

Dauerhafte exakte P0-Vorbereitung, feste aktuelle Claim-/Policyphasen ohne gehaltene Locks während Drain, Wiedererwerb der Ownerfences, atomarer Datei-/Link-/Admissionabschluss, geprüfter Editor-Rejoin und tatsächlicher neuer Browserfall 9. Die vorbereiteten privaten Client- und Live-PG-Kandidaten sind noch keine Integration oder Laufabnahme. Allgemeine Aktivierung, Dateiaktions-Undo und Review Center bleiben aus.
