# Pristine-Bootstrap: explizites Erstformat

Stand: 2026-10-14. Sourcebasis `6cee66086b4d6044742fea143a6b5dcd5844e467`, fokussierter Quellcodecommit `d26105d35095a2145925d8ee707f02831ae5efaa`. Diese additive Grundlage ist noch nicht an Session-, API- oder UI-Einstiegspunkte angeschlossen.

Der [Originalquellen-Bootstrap](../app/lib/collaboration/markdown-file-import-persistence.ts) nimmt zusätzlich `initialRepresentation?: 'auto' | 'plain_text' | 'tiptap_xml' | 'tiptap_blocks'` entgegen. Ausgelassen und `auto` erhalten das bisherige Verhalten: bevorzugt Blocks; mit `richFormat: 'tiptap_xml'` exakt XML, bei nicht verlustfrei darstellbarer Quelle Plain. Explizites Plain bleibt auch bei Rich-fähigem Markdown Plain. Explizites XML oder Blocks wird exakt vorbereitet und bei Source-only-Inhalt vor jeder Initialisierung abgelehnt.

`richFormat` ist ausschließlich eine Auto-Präferenz. Jede explizite Nicht-Auto-Auswahl zusammen mit `richFormat` ist ungültig, auch bei gleicher Rich-Darstellung. `.txt` akzeptiert nur Auto oder Plain; explizites Rich wird vor einem Datenbankcheckout abgelehnt. Die Auswahl wird aus eigenen aufzählbaren Datenfeldern vor dem ersten `await` privat kopiert. Getter, fremde Prototypen, Symbolfelder und nicht aufzählbare Felder werden abgelehnt. Die explizite Auswahl gehört zum privaten Requestfingerprint; die bisherige Auto-Fingerprintform bleibt erhalten.

## Wiederholbare Prüfungen

```sh
npm run test:collaboration:pristine-initial-format:postgres
npm run test:collaboration:pristine-original-bootstrap:postgres
npm run test:collaboration:markdown-file-import
```

Die [neue Fixture](../scripts/workspace-pristine-initial-format-postgres-test.ts) verwendet den bestehenden verwalteten PG18-Dienst, eine private lokale Env-Datei, ein eigenes Zufallsschema, eine Workspace-ID mit UUID und temporäre Originaldateien. Sie startet keinen Server oder Container. Cookie/Bearer-Anmeldung, signierte Team-Lizenz, `canRead` ohne `canWrite`, Original-FS-Prüfung, echte Lifecycle-/Principal-Transaktionen und tatsächlicher COMMIT-/Recoverypfad werden ausgeführt. Private Konfiguration und Credentials werden nicht ausgegeben.

Ausgeführt und bestanden: zwölf neue Fallgruppen mit explizitem Plain, Auto/XML/Blocks, Source-only-Abweisung ohne Seed, leerem seq0, BOM/CRLF, exakter 5-MiB-Grenze, ungültigen Optionen vor Checkout, späterer Inputmutation, TXT, verlorenem COMMIT für alle drei Darstellungen und nachfolgender Representation-/Generationdrift. Die Assertions vergleichen tatsächliche native Darstellung und Byteprofil, Originalbytes sowie historischen Receipt gegen aktuelle Observation.

Unveränderte Regressionen bestanden: [29 ursprüngliche Bootstrap-Fallgruppen](../scripts/workspace-pristine-original-bootstrap-postgres-test.ts), [allgemeine Import-PG-Matrix](../scripts/markdown-file-import-postgres-test.ts), [acht Compilerfälle](../scripts/markdown-file-import-test.ts), vollständiges TypeScript mit 8-GiB-Heap und scoped ESLint. Die ursprüngliche 29er-Fixture bleibt bytegleich; 24 bestehende Funktionen im Persistenzmodul bleiben bytegleich. Geändert wurden ausschließlich `captureOriginalBootstrap` und `persistPristineOriginalWorkspaceFile`.

GitNexus vor dem Edit: `captureOriginalBootstrap` LOW, ein direkter/ein gesamter Aufrufer; Bootstrapexport LOW, keine Aufrufer; jeweils null Prozesse. Frischer Index und staged `detect_changes` für den Quellcodecommit: zwei Dateien, 38 Symbole, null betroffene Prozesse, LOW. Diese Prüfungen belegen die additive Bootstrapgrundlage; Browser-, HTTP-/WS-Session-, Deployment- und Produktionsnachweise stehen separat aus.

## Quellidentität

Root integriert die beiden geprüften Agentcommits nach dem separat geschlossenen macOS-Linkfix. Die Produktdatei und neue Fixture stimmen vollständig mit dem Quellcodecommit überein; alle 24 anderen Persistenzfunktionen sowie die drei ursprünglichen Bootstrap-/Importfixtures bleiben bytegleich. Root bestätigt unabhängig die zwölf neuen echten PG18-/Auth-/FS-Fallgruppen, 29 ursprüngliche Bootstrapgruppen, die tatsächliche allgemeine Import-PG-Matrix und acht Compilerfälle, vollständiges TypeScript mit 8 GiB und fokussiertes ESLint. Der erste allgemeine Import-Aufruf ohne managed PG-Konfiguration meldet ausdrücklich SKIP und zählt nicht als PG-Nachweis; der anschließende Aufruf mit privater lokaler Env-Dateireferenz besteht tatsächlich. Keine Session-/Route-/UI-Aktivierung.

| Datei | SHA-256 nach dem Quellcodecommit |
| --- | --- |
| Persistenzmodul | `f80d50af6fc9fd25d91236e43b11b4fb49dd7d9a610eaac509828137ebf49c3d` |
| Neue Formatfixture | `472805a7b5ec929d191b17b81fe8a1b03996c77241943c9a53ad82927cad2936` |
| Unveränderte ursprüngliche Bootstrapfixture | `c928c830fe16dfda7694405d3c7c6bc525819e1f954b7620819086147a583381` |
