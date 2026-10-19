# Gemischtes Markdown: zentraler Delete-Anschluss

Stand: 19. Oktober 2026. Ausgangsrevision `ec5fce2e73ad874ceff98b89d95052468ae611db`. Diese Teilabnahme betrifft das Löschen eines nativen Notebook-Dokuments bei weiter vorhandenem uninitialisiertem Markdown. Die gesamte MVP-Freigabe bleibt offen.

## Verhalten

Der neue explizite Delete-Identitätsvertrag 3 bindet Evidence 3 und den vollständigen gemischten Lesegraphen. Unveränderte physische Markdownquellen behalten ihre Originalbytes, Metadaten, Parserinventare, Aliase und Selbstlinks. Sie erhalten keine erfundene native Identität. Der gemeinsame Compiler bleibt Vertrag 3 / Compiler 1. Historische Delete-Identitäten und Intent-/Completionverträge bleiben getrennt.

Neue Intent-/Completionversion 5 bindet den vollständigen aktuellen Witness und die tatsächliche P0-Zulassung. Identity3 kann keinen alten Intent übernehmen; Version5 kann keinen alten Plan übernehmen. Beide aktuellen Identitäten 2 und 3 durchlaufen den bestehenden tatsächlichen Zeilenpin-, Quellen-, Reservierungs- und Quiescencepfad. Header, Claim, aktuelle Rechte, Originalactor und SQL-/FD-Owner bleiben erforderlich. Ein fehlender dauerhafter Header ist kein Anlass, historische Autorität neu zu erzeugen.

Der endgültige Graphvergleich erfasst die tatsächlichen Beobachtungen vor und nach den eigenen Änderungen auf derselben B2-Verbindung. Er prüft den vollständigen Katalog nach inverser Einfügung genau der tatsächlich vorher gelesenen Zielzeile in ursprünglicher Datenbankreihenfolge. Erst nach diesem Beweis werden allein katalogabgeleitete physische IDs normalisiert; ursprüngliche Bytes, Links, Metadaten und alle übrigen Quellenfakten bleiben exakt gebunden. Native Linkreceipts, Archivierung und ursprüngliches Trash-Original bleiben gemeinsam erforderlich.

Ausgewähltes rohes Markdown und notwendige rohe Linkänderungen bleiben vor Seiteneffekten gesperrt und benötigen weiterhin den eigenen tatsächlichen Import-/Rebindinganschluss. Der neue Undoarm ist ausdrücklich gesperrt; Dateiaktions-Undo, Review Center und Root-Aktivierung bleiben aus.

## Ausgeführte Prüfung

`node scripts/run-document-read-tool-dispatch-test.mjs scripts/workspace-operation-mixed-delete-postgres-test.ts` ruft den tatsächlichen öffentlichen MCP-Dienst aus einem echten Fixture-JWT mit gespeicherter Sitzung, Consent und aktuellen Workspace-/Delete-Rechten auf. Der bestehende Claim, Owner, PostgreSQL18 und tatsächliche FD-/Trashweg werden verwendet. Keine ersetzte Autorität, kein erfundenes SQL-Ergebnis und kein direkter alternativer Owner.

Alle **acht echten Gruppen** bestehen in 43,498 Sekunden:

1. Vorschau mit vollständigem gemischtem Graphen und vollständigen NoWrite-Orakeln.
2. Tatsächlicher FD-/Trashabschluss, native Archivierung und exakte zentrale Entfernung des eingehenden Links; alle übrigen Inhalte/Formatierungen, Alias-/Selbstlinks und ursprünglichen rohen Quellen bleiben erhalten.
3. Abgeschlossener Status, erneutes Apply und ausdrückliches Recover lesen die Originalbelege ohne Domainwrites.
4. Ausgewähltes rohes Markdown bleibt vor jedem Write importpflichtig.
5. Notwendige rohe Linkentfernung bleibt vor jedem Write importpflichtig.
6. Nach Preview geänderte rohe Bytes führen ohne Seiteneffekt zum Plankonflikt.
7. Tatsächliche Write-, Delete- und JWT-Scopeberechtigungen werden unabhängig geprüft.
8. Nach echtem Completion-COMMIT ist der Originalbeleg unabhängig sichtbar; erst danach wird ein Bestätigungsverlust eingespeist. Eine echte erneuerte SID-B setzt dieselbe Originaloperation mit ursprünglicher SID-A, unveränderten Intent-/Receiptzeilen und gebundener anschließender Historie fort.

Gezieltes TypeScript (18,891 Sekunden), Scoped-ESLint (2,388 Sekunden), acht reine Plan-V3-Gruppen (3,026 Sekunden) und **93 bestehende Node-Testfälle** (34,910 Sekunden) bestehen. Der private Node-Launcher wählt ausschließlich für die installierten import-only PI-Pakete deren tatsächliche Import-Exportbedingung; PostgreSQL-, Tiptap- und Yjs-Konstruktoren werden weder ersetzt noch global auf andere Auflösungsbedingungen umgestellt. Kein Produktloader wurde geändert.

Die unveränderte tatsächliche MCP-/PG18-/FD-/Live-Room-Ownerfolge besteht mit **16/16** in 350,530 Sekunden. Die ursprüngliche Raw-Gegenprobe besteht jetzt mit **Copy bereit / Move bereit / Delete bereit** und allen sechs vollständigen NoWrite-Paketen in 26,425 Sekunden; ihr früherer Exit 1 bleibt historisch erhalten. Diese Vorschaugegenprobe migriert keine Quelle und ersetzt nicht den noch offenen ausgewählten Raw-Import.

Die NoWrite-Orakel umfassen tatsächliche Domainzeilen samt xmin, Tabellen-/OID-Inventar und den vollständigen privaten DATA-Baum einschließlich Identitäten und Bytes. Drei unabhängige READ-ONLY-Ressourcenprüfungen bestätigen jeweils: eigenes Schema und OID entfernt, eigene Backends geschlossen, eigenes DATA entfernt und Originalprozess beendet. Vier verwaltete Dienste behalten ihre ursprünglichen IDs und sind gesund; kein Container wurde gebaut oder neu gestartet.

Private Originalbelege: `/private/var/folders/bx/tjzzmjhn2qdcdyfc_l7hkv900000gn/T/canvas-m1-delete-v3-ei0nmc2f/validation6`. Alle während der Folge erfassten Originalquellen bleiben identisch.

Gebundene SHA-256-Belege:

- `terminal.json`: `dc8065f7599ea8209775010100fc33d96950c647f73977f2ec2425ddbbb64d19`
- `independent-mixed-delete-resource-report.json`: `d196c3f82874dfc95e0714734582ec8c3ae277dedbecf297dff007109a378ab4`
- `independent-baseline-resource-report.json`: `19d4b2acbb5b46f3d51371cb97605ecf5cb52504bcc2b17fff6a50f940852083`
- `independent-raw-boundary-resource-report.json`: `3506f1202abe70d8374d59599bad89ea6d3aceae70a441117bbf132c55da3574`
- `scripts/workspace-operation-mixed-delete-postgres-test.ts`: `a73ce69cca550e8ff955c85ee0e9dce57a8fdb1f666c296d517ddd628faa1eaa`
- `app/lib/files/workspace-operation-native-delete-plan.ts`: `2d0c753ab1aedab78edd047fb8562381a84fcc96726e10a88032118a55ff21f4`
- `app/lib/files/workspace-operation-native-path-admission.ts`: `634bc53cff741eedbe42f6c0f112c63abd763ec9f5ffd902be53d6f87dd1b565`

Die tatsächlichen früheren Fehlversuche bleiben erhalten: `validation3` und `validation4` scheitern an `JOB_LIFECYCLE_CHANGED`, weil die neue Identität vor dem Owner noch fälschlich den historischen READY-Arm ohne P0 durchlief. Der enge Zulassungsfix schließt genau diese Lücke. `validation5` erreicht den erfolgreichen zentralen Abschluss und scheitert danach ausschließlich am Strukturvergleich von schemaeigenen Nullprototyp-Attributen gegen gewöhnliche JSON-Objekte. Beide Dokumente werden nun für den Vergleich vollständig als JSON normalisiert; sämtliche Inhalts-, Link-, Formatierungs- und Originalbytesprüfungen bleiben erhalten. Alle drei fehlgeschlagenen Datenbankläufe besitzen unabhängige Ressourcenabschlussbelege. Frühere Typ-/Fixture- und Loaderfehler sind ebenfalls privat erhalten und zählen nicht als bestandene Tests.

## Verbleibende MVP-Grenzen

Dies ist kein neuer Browser-, UI-, Produktionsbuild-, vollständiger E2E- oder Auslieferungsnachweis. Der ursprüngliche konkrete Produktionsfall ist damit noch nicht direkt abgenommen. Tatsächlicher Raw-Import/Rebinding, interne zentrale Neuanlage, Linux-Schreibschutz und CI-Anschluss sowie gemeinsame finale Abnahme mit Produktionsaktivierung bleiben im [MVP-Launchplan](./yjs-document-authority-mvp-launch-plan.md) offen.
