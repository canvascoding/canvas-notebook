# Nativer Move/Rename: ursprünglicher Auftrag, Ausführung und Status

Stand: 16. Oktober 2026. Worktree-Implementierung, kein Produktionsrollout. Dateiaktions-Undo und Review Center bleiben ausgeschaltet. Der allgemeine native Aktivierungsgate samt offenen kooperativen Writer-Familien bleibt bestehen.

## Implementierter Vertrag

- V3 verwendet den ursprünglichen nativen Pfad-/Linkplan. Sein historisches `executionReady: false` ist kein Ausführungsschalter und keine Autorität. Erst echter aktueller Job-Claim, fester Owner, aktuelle Rechte, ursprüngliche Quellenprüfung und Admission-Protokoll erlauben eine Mutation.
- Der Owner hält die tatsächlichen Workspace-/Room-Grenzen über B1, Dateisystem und B2. B1 schreibt Originalintent, NativeBundle und Admission auf derselben Verbindung. Physische Schritte verwenden Descriptorbelege, persistierte Elterngeburten und genaue Consumerbindungen. B2 verbindet ursprüngliche native Änderungen, Metadatenfolgen, Finalgraph, Admission-Outcome und Abschlussjournal in einem Commit.
- Native-only Notizen und logische Ordner benötigen keine Markdown-Projektion. PDF-/Assetbewegungen aktualisieren echte native Verweisquellen; Assets erhalten keine erfundene native Dokumentidentität.
- Eigene unvollständige Aufträge können anhand ursprünglicher Belege wiederaufgenommen werden. Fremde Reservations, veränderte Ziele, ersetzte Altpfade und gefälschte Caps werden nicht übernommen. Historisch vollständig abgeschlossene Aufträge werden nicht erneut ausgeführt.
- Historischer GET prüft aktuelle Leserechte und unveränderliche Originalbelege. Spätere legitime Texteingaben, Metadaten und D2-/S2-Belegungen ändern nicht die Bedeutung des bestätigten Abschlusses. Readonly weist keine XID zu und verlangt keine Rowlocks oder heutigen Yjs-/Namespace-Rescans.
- Alle zehn verwendeten V3-Historyrelationen werden vor/nach dem Lesen über qualifizierte und unqualifizierte OID-Auflösung ans ursprüngliche Batchschema gebunden. Shadow-History-Schemas werden vor dem Beleglesen abgewiesen.
- Regulärer Producer, Executor, Status und Antwortaufbau unterscheiden V3 ausdrücklich. Auch Assets benötigen V3, wenn der Workspace native Verweisquellen enthält. Gemischte bzw. Overwrite-Aktionen werden vorerst ausdrücklich abgewiesen; sie fallen nicht in eine unvollständige V1-Dateiansicht zurück.
- Rename-Dryrun und Dateimenü zeigen native Linkänderungen als Pfad-/Literalzusammenfassung einschließlich Wiki-Alias. Native IDs, Yjs-Positionen, Binärzustände und private Quellen-/Graphbelege bleiben privat; Markdown-Textbereiche werden nicht erfunden. Der V1-Previewvertrag bleibt erhalten.

## Tatsächliche Prüfungen vor der Browserabnahme

Die echte PG18-Owner-/Executor-Fixture besteht **13 Gruppen**: native-only Notiz mit eingehendem Link und Metadaten; PDF/link-only mit Assetmetadaten; gefüllter Ordner; zwei Wurzeln mit gemeinsamem Zielordner; eigene Wiederaufnahme nach FS; historischer Abschluss mit späterem D2; gefälschter Owner/nackte Verbindung; entzogene Rechte; fremde Admission; Cap-Poisoning; Detached-/Drain-Grenze; tatsächliches Beenden der eigenen B-Verbindung und Recovery; regulärer Executor/Claimabschluss/Execution/Public/Response einschließlich späterer echter Yjs-Persistierung, Metadaten/D2/S2, historischer Wiederaufnahme, tatsächlichem Readonly-Trace und Shadow-Schema-Gegenfall. Unterprüfungen der letzten Gruppe werden nicht als zusätzliche Gruppen gezählt.

Originallog: `/var/folders/bx/tjzzmjhn2qdcdyfc_l7hkv900000gn/T/canvas-original-move-executor-final-o871vr4m/actual-run.log`, SHA-256 `376bd1ab052c25e3427a5b8e75f82dc736a1e0e13a1db549cd8948df9e44f727`. Alle 19 gepinnten Quellen bleiben während dieses Laufs bytegleich. Eigene Schemas, Shadow-Schema, DATA und Clients sind geschlossen; die frische Abschlussprüfung bestätigt unveränderte verwaltete Container und drei erfolgreiche Healthchecks. Abschluss-SHA `baa866b67f1c7786e5a49b7e2ecb9abea12c173af2c34f009613e4012c42aa2c`.

Zusätzlich bestanden:

- 40 tatsächliche Prepared-Dateisystemfälle und 57 Quellen-/Graphfälle.
- 30 native Pfadplanfälle und 31 strenge Originalcodec-Fälle.
- Zwölf Namespace-/Public-/Preview-Fälle mit echtem Yjs/Planer, einschließlich Plain/XML/Blocks, Wiki-Alias, fremden Locks und Metadaten-Zielinjektion. Deklarierte Metadaten-/Receipt-Fixtures sind keine eigenständigen SQL-Commitbeweise.
- Zwölf Original-Repositoryfälle und neun zusätzliche echte embedded-PG-Readonly-Grenzen; diese Probe wird nicht als PG18-/Owner-/ACL-Lauf gezählt.
- Beide unveränderten Original-PG-Regressionen für NativeHandoff und NativeSideeffects. Ergebnis-SHA `21a955e496e437118dfc2b248b8891585f335960cfb92c2cb76638f21a4a2be6`; fünf Quellen/Testdateien bytegleich. Der dort dokumentierte Writer-Phantom-Aktivierungsgate bleibt offen.
- Dreizehn Datei-Undo-API-/Queue-Gruppen und zehn Desktop-/Mobile-Hookfälle bestätigen die unveränderte Abschaltung; der ursprüngliche Restorefehler wurde nicht repariert.
- Gezielte Regressionen für direkten Auftragsservice, Client und Antwortprojektion. Clienttests verwenden normale React-Bedingungen, Servertests die React-Server-Bedingung.
- Vollständiges TypeScript und Lint aller geänderten TS-/TSX-Dateien: tatsächliche Exitcodes 0/0, alle Quellen vor/nach bytegleich. Bericht: `/var/folders/bx/tjzzmjhn2qdcdyfc_l7hkv900000gn/T/canvas-native-move-final-static-0wkv80b4/results.json`.

## Erster Browserlauf und noch ausstehende Move-Abnahme

Der erste frische Produktionsbuild auf Root `877808906` / QA `ebfa867ad` besteht einschließlich unabhängiger Quellen-/Artefaktprüfung und Native-API3-Prüfung. Im tatsächlichen Browserlauf bestehen Undo-Sperren 2/2, Starterinitialisierung 2/2 und nativer Link-Delete 2/2. Die vier neuen Move-Fälle scheitern bereits bei der Workspace-Anlage mit HTTP 400 `WORKSPACE_NAME_TOO_LONG`: Der Testname hatte 81 Zeichen bei einem API-Limit von 80. Kein Move wurde erreicht. Die Fixture verwendet jetzt acht Zeichen der Nonce und bleibt mit 57 Zeichen unter dem unveränderten Produktlimit; alle Prüfbedingungen bleiben unverändert.

Originalbeleg: `/private/var/folders/bx/tjzzmjhn2qdcdyfc_l7hkv900000gn/T/canvas-yjs-authority-v1lYpf/recovery.json`. Die unabhängige Nachprüfung bestätigt zehn deklarierte Fälle, sechs bestanden und vier fehlgeschlagen, ohne übersprungene Fälle. Ihr Bericht `/private/var/folders/bx/tjzzmjhn2qdcdyfc_l7hkv900000gn/T/canvas-yjs-independent-runtime-closure-22gc6cay/postruntime-report.json` hat SHA-256 `d5721d90f187471cc1b389039c9ad21327736d646664f617657b7440fa362bec`. Der ursprüngliche Fehlerbeleg bleibt unverändert; eigene zurückbehaltene Testressourcen werden separat geschlossen.

## Zweiter Browserlauf: neun von zehn Fällen, falsche URL-Erwartung

Der frische Build auf Root `56a097865` / QA `75f2e6a72` besteht samt unabhängiger Artefaktprüfung und separater Native-API3-Verifikation. Source-Fingerprint `aed7f77d43844d2f61c7f44cccca99adb89ba9024828544e24efa3704591a6a3`, Build-Fingerprint `133f8697817806c35bc4f18e1c25f2a28057682f10c1ed7d78a002b707814cbf`. Der tatsächliche Zehn-Fall-Lauf besteht **9/10**: Undo-Sperren 2/2, Starter 2/2, nativer Link-Delete 2/2 und drei der vier Move-Fälle. Mobiler Move samt ausgehendem Relativlink, PDF-Asset-Move samt bytegleichem Download und ausdrücklich blockierter HTML-Source bestehen.

Desktop-Rename scheitert nach erfolgreichem `applied`, ursprünglicher ID/Generation, unverändertem übrigen Dokument und frischem exaktem Backlink-PM-/Proof-/Vector-Vergleich an der URL-Erwartung nach Control-Klick. Der Trace belegt bereits den richtigen Ziel-Read und Session mit HTTP 200; der Screenshot zeigt den neuen aktiven Tab und Zielinhalt. `openWorkspaceMarkdownTarget` öffnet über den File-Store und schreibt dabei keine Browser-URL. Die bestehende Linknavigation-Spec prüft deshalb Header und Inhalt. Die neue Spec übernimmt diese tatsächliche Vertragsprüfung; danach bleiben die ursprünglichen PM-/Proof-/Vector- und Room-Release-Assertions erhalten. Dies ändert ausschließlich den Test, keine Produktfunktion und keinen Timeout.

Originalbeleg: `/private/var/folders/bx/tjzzmjhn2qdcdyfc_l7hkv900000gn/T/canvas-yjs-authority-9U05Yx/recovery.json`; der Supervisor endet tatsächlich mit Exit 1 und erhält die fehlgeschlagene Fixture. Der ursprüngliche Bericht bleibt unverändert. Frischer Build und derselbe vollständige Zehn-Fall-Lauf nach dieser Korrektur stehen noch aus. Die regulären Producer-/API-/UI-Preview-Anschlüsse wurden nach dem PG-Ownerlauf ergänzt; dessen Erfolg ersetzt ihre Browserabnahme nicht. Copy, vollständige gemeinsame API-/MCP-/SDK-/Such-/PDF-Anlage-/Sandboxabnahme und allgemeiner Aktivierungsgate bleiben Teil des Gesamtauftrags.
