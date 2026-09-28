# DA-03: explizite Vacancy und Zuordnung normaler Release-Belege

Stand: 27. September 2026, aufbauend auf `3c6d6af30`.
Teil des [Distributed-Admission-Plans](distributed-admission-plan.md).
**DA-03 insgesamt bleibt offen.** Kein Default-Aufrufer, keine Aktivierung,
keine Lifecycle-Mutationsberechtigung, kein Abschluss von FVRC-1008 oder P12.

## Vertrag und Umsetzung

Die Reservation bindet jetzt zusätzlich die domänengetrennten SHA-256-Hashes
der vollständigen gespeicherten Yjs-Update- und Vektordaten. Eine identische
Sequence oder ein identischer Vektor allein reicht nicht: Ein DeleteSet-only-
Update kann bei gleichem Vektor andere Daten besitzen. Alte Snapshots ohne
Hashes werden vom neuen Proof-Pfad verweigert, nicht nachträglich ergänzt.

`createCollaborationAdmissionQuiescenceService().prove(request, documentId)`
erwirbt in einer kurzen Transaktion zuerst **try-only** den bestehenden
Room-Advisory-Lock als Transaktionslock und danach Request-, Target- und
State-Zeilenlocks. Unter diesen Sperren prüft er vollständige Request-Identität,
Ausgangssnapshot, Dokument-Scope, Generation, Darstellung, Schema und Daten.
Er nimmt keinen Workspace-Guard unter einem wartenden Owner-Lock.

Es gibt drei verschiedene Belege:

- `vacant`: ausschließlich Epoch 0 mit vollständig leerem Owner-Tuple und
  exakt reservierter Sequence sowie beiden Datenhashes. Der gespeicherte
  vollständige Yjs-Zustand und sein Vektor müssen valide sein.
- `normal_release`: vorhandener Receipt für genau Dokument-ID und reservierte
  Epoch, niemals der zeitlich „neueste“. Aktueller Zustand und Receipt müssen
  vollständig zusammenpassen. Ein bei Reservation noch vorhandener Owner wird
  mit Token, Backend-PID und Backend-Start geprüft; sein finaler Store darf die
  Sequence seit Reservation erhöhen. War die Freigabe bereits vorher erfolgt,
  müssen auch die reservierten Daten exakt unverändert sein.
- `owner_drain`: DA-02-Receipt mit exakter deterministischer Ticket-ID.
  Der Owner setzt diesen Marker schon atomar mit Receipt und Token-Clear;
  der neue Dienst ergänzt nach Guard-Übernahme den vollständigen State-Proof.
  Ein Marker ohne Prooftext ist deshalb keine Quiescence-Autorität.

Der neue Receipt-Validator benötigt nicht die ursprünglichen Livebytes:
Er prüft aktuelle gespeicherte Bytes gegen die unveränderlichen Receipt-
Hashes. Livehashes bleiben vertrauenswürdige Receipt-Metadaten. Die bestehende
Owner-Recovery bleibt strenger und bindet weiterhin ihren ursprünglichen
unveränderlichen Livesnapshot; dieser Vertrag wurde nicht abgeschwächt.

Der kanonische Prooftext bindet Version, Request/Digest, Ausgangssnapshot-
Digest, Belegart, vollständigen aktuellen Zustand einschließlich Raw-Hashes
und gegebenenfalls den vollständigen normalisierten Receipt. Das Target
referenziert/pinnt den Receipt über seinen bestehenden Fremdschlüssel.
Migrationen ergänzen nur nullable Spalten und sind wiederholbar.

Die Zuordnung funktioniert sowohl vor als auch nach normalem Unload und
auch dann, wenn schon ein DA-02-Drain angefordert war. Normale Release-IDs
werden niemals in deterministische Owner-Tickets umgedeutet. Nur echte
`owner_drain`-Targets bleiben für einen noch ausstehenden lokalen Finish
im Owner-Polling sichtbar.

## Fehler, Wiederholung und Grenzen

Target bleibt aktiv, Request wechselt zu `draining`. Ein erfolgreicher
Proof öffnet weder Claims noch erlaubt er Cancel, Restore oder eine Mutation.
Identischer Retry bestätigt denselben Beleg ohne neue Wirkung. Abweichende
Daten, Scope, Epoch oder gespeicherte Proof-Felder werden verweigert.

Bei verlorener COMMIT-Antwort wird die alte Verbindung zuerst verworfen.
Eine neue Transaktion erwirbt den Guard erneut und liest den exakten dauerhaften
Beleg. Dieser Recovery-Pfad schreibt nichts und rekonstruiert keinen fehlenden
Beleg. Fehlt ein bestätigter COMMIT, bleibt nur ein ausdrücklich gleicher
späterer Versuch; fehlschlagendes Schließen erlaubt keinen Recovery-Erfolg.

Ein freier Advisory-Lock mit altem, nichtleerem Owner-Tuple und ohne Receipt
bleibt ein Recoveryfall. Es gibt kein automatisches Token-Löschen, keine
Epoch-/Generationserhöhung und kein blindes Wiederanwenden alter Bytes.
Das Gleiche gilt für archivierte Epoch->0-Zustände, deren Scope nicht mehr dem
aktiven Release-Receipt entspricht: Sie benötigen den späteren Lifecycle-
Outcome-Vertrag, keine erfundene Vacancy.

**DA-04 muss den Room-Guard erneut erwerben, den Beleg frisch revalidieren
und den Guard bis zum bestätigten Lifecycle-Ergebnis halten.** Die hier
gespeicherten Belege ersetzen diesen Schritt nicht. Ebenso offen bleiben
vollständige Restart-/Crash-Fortsetzung, Terminalisierung mit nachlaufendem
lokalen Finish, sämtliche Domain-Writer-Gates und Zwei-OS-Prozess-Abnahme.
Altserver können Advisory-Konventionen ignorieren; deshalb bleibt das
Fleet-Gate zwingend. Belege/Receipts dürfen nicht vor Outcome- und
Retry-Retention entfernt werden.

## Verifikation

- Snapshot-Vertrag: **7/7**; zusätzlich Release-Proof-Validator **5/5**
  und erweiterter Drain-Vertrag **11/11**. Die ersten Snapshot-Läufe fanden
  zwei Fehler: `Number(null)` akzeptierte fehlende Epoch-/Sequence-Werte als
  Null; der Decoder gab für beschädigte gespeicherte Owner-Tuples einen
  Request- statt Scope-Fehler aus. Beide Produktfehler sind korrigiert,
  Erwartungen nicht abgeschwächt.
- Vollständige Lifecycle-Suite und echte PostgreSQL-Regressionen für
  Reservation, gebundenen Drain, Owner, Release und normalen Idle-Release
  bestehen. Alle Datenbanktests nutzen eigene generierte Schemata;
  der Persistenzschreiber darin ist ein expliziter gefenceter Testadapter.
- Neues echtes PostgreSQL-Harness: **18 geprüfte Grenzen**, einschließlich
  aller drei Belegarten, normaler Freigabe vor/nach Reservation und nach
  Drain-Anforderung, gleicher Vektoren mit anderen Updatebytes, altem Token
  ohne Receipt, busy Guard, Daten-/Scope-/Epoch-Drift, gesperrtem Neu-Claim,
  Receipt-FK, manipuliertem Prooftext, verlorener/abgewiesener COMMIT-Antwort
  und fehlgeschlagenem Backend-Discard ohne anschließenden Recovery-Read.
  Ein frischer identischer Retry wird positiv nachgewiesen. Das Harness
  simuliert auch eine alte Target-Tabelle ohne neue Spalten und führt die
  additiven Migrationen zweimal aus.
  Logs: `/tmp/fvrc1008-admission-quiescence-postgres-verified.log`,
  eigenständiger Wiederholungslauf
  `/tmp/fvrc1008-quiescence-postgres-final.log`.
- TypeScript, fokussiertes ESLint und Produktionsbuild bestehen.
  Keine Container gebaut oder neu gestartet, keine Dependencies verändert.
- Ein separater Peerreview fand keinen Safety-Blocker. Der neue Digest-
  Import erweitert einen bestehenden Runtime-Modulzyklus; die Runtime- und
  Buildprüfungen sind grün, eine spätere Leaf-Extraktion bleibt Wartungsarbeit.

Prüflogs: `/tmp/fvrc1008-quiescence-lifecycle-r2.log`,
`/tmp/fvrc1008-quiescence-types-final.log`,
`/tmp/fvrc1008-quiescence-lint-final.log`,
`/tmp/fvrc1008-quiescence-build.log`; PostgreSQL-Regressionen
`/tmp/fvrc1008-quiescence-*-regression.log` und
`/tmp/fvrc1008-quiescence-admission-final.log`.

## Browser auf dem aktuellen Host-Dev-Stand

Nach erfolgreichem Build wurde ausschließlich der eigene Host-Dev-Prozess
auf **127.0.0.1:3000** neu gestartet. App, PostgreSQL, Auth und Collaboration
meldeten danach gesund. Der Skill-Stack mit PostgreSQL 18.4/pgvector 0.8.3
und Control Plane blieb unverändert; der Notebook-Container auf **3100**
verwendet weiterhin sein älteres Image.

Team-B/C besteht in **24,0 s**: Nach Annahme von C bleibt B als konkreter
Konflikt offen, ohne Timeline-Fehler und ohne unsafe Accept-Aktion. Screenshot
visuell geprüft. Report:
`/tmp/fvrc1008-quiescence-team-conflict-report/index.html`.

Team „10 → 3 einzeln → 7 gesammelt“ besteht in **56,1 s**: exakter
Endtext, vier neue Revisionen, idempotente Wiederholungen und keine offenen
Reviews. Screenshot visuell geprüft. Report:
`/tmp/fvrc1008-quiescence-team-batch-report/index.html`.
Beide Fälle liefen seriell mit einem Worker und mindestens 55 Sekunden
Abstand nach bestätigtem Abschluss. Personal wurde in diesem Schritt nicht
erneut im Browser geprüft; frühere Nachweise bleiben separat.

Die Browserfälle treffen die bestehende Review-Oberfläche, **nicht** den
noch deaktivierten Owner-/Admission-Adapter. Sie sind keine verteilte
Lifecycle- oder Crash-Recovery-Abnahme.

Lesender Datenbankcheck: **0 aktive Owner-Epochen größer null, 0 Admission-
Requests im App-Bestand und 0 verbliebene neue Testschema-Namespaces**.
Es wurden keine Lizenzen oder Secrets geändert.

GitNexus vor Commit: **15 erwartete Dateien, 97 indexierte berührte Symbole,
0 zugeordnete Prozesse**, automatisch LOW. Das ist eine begrenzte
Indexeinschätzung, kein Beweis für fehlende Laufzeitabhängigkeiten. Der gesamte
Branch gegenüber `main` bleibt CRITICAL mit **288 Dateien und 30 Prozessen**;
keine Merge- oder Produktionsfreigabe.
