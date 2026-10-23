# Native Dokumentbearbeitung: versionsgebundene Vorbereitung

Stand 18. Oktober 2026. Dieser Schnitt implementiert den strikten V1-Anfragevertrag und eine reine native Vorbereitung. Er stellt noch keine öffentliche Edit-API bereit. Der bestehende Operationsowner, aktuelle Berechtigungen, tatsächlicher Raum-CAS, dauerhafte Speicherung und die Transportadapter sind der nächste Anschluss.

## Vertrag und vorhandene Writer

`app/lib/documents/edit-contracts.ts` bindet `apiVersion`, Workspace, stabile Dokument-ID, vollständige `expectedVersion`, Idempotenzschlüssel und gezielte Änderung. Zulässig sind Textänderungen mit exakten Trefferzahlen sowie die sechs vorhandenen Blockoperationsformen. Pfad, Actor, Session, rohe Yjs-Updates und vorbereitete interne Targets können nicht über den Anfragevertrag eingeschleust werden. Der kanonische Fingerprint enthält den vollständigen fachlichen Request einschließlich Version; der Retryschlüssel und der aktuelle Sessionkontext werden gesondert behandelt. Der Decoder erteilt keine Autorität.

`native-document-edit-preparation.ts` benutzt die vorhandenen Text-/Blocktargets und deren tatsächliche Writer. Schema, native Inhalte und vollständige Versionsvorbedingung werden auf einem eigenen `gc:false`-Klon geprüft. Quellbytes, Rootobjekte und Update-Events bleiben unberührt. Native XML-/Blockdokumente mit Tabellenbreiten benötigen keinen verlustfreien Markdownexport für diese Vorbereitung. Exakte Trefferzahlen, Graphemgrenzen, Überlappungen, aktive IME-Komposition und feste Größen-/Zielgrenzen bleiben wirksam. Gleicher Text prüft das Ziel, erzeugt aber keine unnötige CRDT-Änderung.

Die vollständige Inhaltsversion verwendet dieselben sieben Identitätsfelder und denselben löschungsbewussten Zustandsbeleg wie Read V1. Ein Zustandsvektor allein reicht nicht: reine Löschungen können ihn unverändert lassen. Identität, Schema-/Größenprüfung, Klonmechanik und Versionsvergleich liegen im writerfreien `native-document-edit-validation.ts`; der bestehende Vorbereiterpfad reexportiert seine beiden öffentlichen Prüffunktionen. Damit kann der spätere Operationsanschluss die Prüfung ohne Rückimport des Vorbereiters und ohne Operations-/Writerzyklus verwenden.

**Vorschaudaten bleiben privat:** `nativeBeforeUpdate`, `nativeAfterUpdate` und `afterVersion` beschreiben den eigenen Vorschauklon. Ein unabhängiger tatsächlicher Writer kann andere Yjs-Clientuhren erzeugen. Der echte Raum muss die Vorbedingung unmittelbar vor seiner synchronen Mutation erneut prüfen und seinen eigenen Nachzustand erfassen. Weder diese Daten noch ein erfolgreicher Vorbereitungsaufruf ersetzen Principal, Owner, Persistenz oder Operationsbeleg.

## Tatsächlich ausgeführte Prüfungen

Die permanente Folge `scripts/native-document-edit-preparation-test.ts` läuft über den vorhandenen ESM-Runner mit echten installierten Yjs-/Tiptap-Konstruktoren und tatsächlichen bestehenden Targetwritern:

```sh
BETTER_AUTH_BASE_URL=http://localhost:3100 NODE_ENV=test node scripts/run-document-read-tool-dispatch-test.mjs scripts/native-document-edit-preparation-test.ts
```

Der finale Originallauf endet mit **Exit 0 und 8/8 Gruppen**. Geprüft sind Plain/XML/Blocks, native Tabellenbreiten trotz instabilem Markdown-Roundtrip, reine Löschungen bei unverändertem Zustandsvektor, gleiche sichtbare Inhalte mit anderer Historie, alle sieben Identitätsfelder, echter Yjs-Peerupdate vor erneuter Prüfung, Unicode/Grapheme/Überlappung/IME, vorhandene Blockwriter einschließlich Tabelle, Noop sowie strikter abgetrennter/fester Decoder und kanonischer Fingerprint ohne Getter-/Proxy-Ausführung. Unabhängiges Wiederholen der Targets vergleicht nativen Inhalt und verlangt keine erfundenen identischen Yjs-Uhren.

| Prüfung | Tatsächliches Ergebnis |
| --- | --- |
| Finale reine Folge nach Aufteilung und EOF-Bereinigung | 8/8, ursprünglicher Runner Exit 0, eigener Bundleordner entfernt |
| ESLint der fünf geänderten Code-/Testdateien | Exit 0 |
| Gezielte cachefreie TypeScript-Importclosure des finalen Schnitts samt bestehender Ambienttypen | Exit 0 |
| Vollständiges cachefreies TypeScript vor mechanischer Aufteilung, 6144 MiB Heap | Exit 2; exakt dieselben 69 bytegleichen Bestandsdiagnosen, keine neue Quelldatei betroffen |
| Unabhängiger Quellreview und anschließender enger Aufteilungsreview | Kein konkreter Befund; reine Quellprüfung, keine zusätzliche Laufzeitabnahme |

Der erste vollständige Typecheck wurde mit Nodes voreingestelltem 4-GiB-Heap gestartet und endet tatsächlich mit Exit 134 wegen Heaperschöpfung vor Compilerdiagnosen. Dieser fehlgeschlagene Lauf bleibt erhalten. Die anschließende 6144-MiB-Folge ist kein vollständig grüner Repository-Typecheck: Ihr Diagnosehash ist wie zuvor `f87d64a219dd9317c7a22890a2687240cbf81b79851e829dd8117faa2ea561e3`.

Originale und Quellenmanifest liegen unter `/private/tmp/canvas-native-id-edit-root-ucsf83us/`. Der finale ESM-Bundlehash ist `f8319fe5e093a077eda45eac8f0770287d43db55d1837a40e9c3256cf433c72e`. Der Übergang der eingefrorenen Validation zur finalen Datei entfernt ausschließlich eine zusätzliche leere EOF-Zeile; danach wurden reine Folge, Scoped-Typecheck und Lint tatsächlich erneut ausgeführt.

## Nächster wichtiger Anschluss

Die vorhandene Agentoperation-/Direktverbindungs-/Raummutex-/Persistenzkette bleibt der einzige Schreibpfad. Erforderlich sind darin native ursprüngliche Anfrage-/Formatbelege, der synchrone vollständige CAS am tatsächlichen Raum, eigener tatsächlicher Nachzustand und nativer Inhaltsbackup über den vorhandenen Version-Content-Store. Der bestehende `resulting_state_snapshot` enthält Zustandsvektor und DeleteSet; er ist kein wiederherstellbarer Inhaltsbackup. Aktuelle Autorität B und unveränderliche ursprüngliche Attribution A müssen bei Retry getrennt bleiben. Unklarer Ausgang braucht eine belegte Status-/Recoveryprüfung derselben Operation und darf keine neue Vollwiederholung auslösen.

Echte PG-/Room-/Principal-/Recoveryprüfungen und danach registrierte REST-/MCP-/PI-/Mobile-Anschlüsse bleiben offen. Es gab für diesen reinen Vorbereitungsschnitt keinen neuen Produktionsbuild oder Browserlauf. Python-SDK, öffentliche Developer-Seiten unter `canvasnotebook.app/docs`, Standard-Skill, PDF-/übrige Sandboxanschlüsse und Gesamt-E2E bleiben im vollständigen Auftrag. Allgemeine Aktivierung, Dateiaktions-Undo und Review Center bleiben aus.
