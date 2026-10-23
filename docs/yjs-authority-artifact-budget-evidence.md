# Build-Artefakte: getrennte begrenzte Inventuren

Stand: 17. Oktober 2026. Dieser Schnitt betrifft ausschließlich den QA-Prüfhelfer und seine Regression. Allgemeine native Aktivierung, SDK, Skill, PDF und gemeinsame Dokumentverträge bleiben im Gesamtauftrag offen.

## Ursprünglicher tatsächlicher Abbruch

Der originale Produktionsbuild auf Root `9339633fa8ae7f6ff287784cce3b52941a146d5b` / QA `4494e2723d8179aff7de6aca43557acc4af7f97e` endet in Sitzung `60166` tatsächlich mit Exit 1. Die Kompilierung und Next-Routenliste sind im Original fertig; die anschließende `buildFingerprint`-Inventur scheitert am globalen `assert(++visited < 100_000)`. Die Browserfolge wurde nicht gestartet und kein neuer erfolgreicher Buildbeleg akzeptiert.

- Original: `/private/var/folders/bx/tjzzmjhn2qdcdyfc_l7hkv900000gn/T/canvas-yjs-build-ZxbE7A/build.log`, SHA-256 `47443fcf8498c6ff917010f402d445296919d8552df0905aae77d29799c22389`, 168.713 Bytes.
- Die reine Quellenprüfung besteht; eine getrennte lesende Diagnose (`28047`, Exit 0) isoliert den Fehler auf den Artefaktwalk. Der unveränderte begrenzte Walk (`65594`, Exit 0) erreicht seine 100.000ste Station bei `static/chunks/1iolnamdhmbu_.js`.
- Die zusätzliche lesende Inventur findet 100.309 verschiedene aktuelle Einträge: 90.096 im Buildbaum und 10.213 in 18 eindeutigen zulässigen Paketzielen. Keine Aliasrekursion, kein `.next/standalone`, keine unerwarteten Symlinks oder verschachtelten Worktree-/Buildbäume sind belegt. Die Chunk-Zeitstempel liegen im aktuellen Buildfenster.
- Eine passive Prozessprüfung findet anschließend keine Node-/npm-/Buildprozesse mit CWD im exakten QA-Checkout oder Buildverzeichnis. Alle neun nur als Node-Warnung im Buildlog beobachteten PIDs sind abwesend. Ursprüngliche Child-Identitäten/Startzeiten/Prozessgruppen wurden nicht ausreichend aufgezeichnet; dies ist ausdrücklich kein vollständiger unabhängiger Originalprozessabschlussbeleg.

## Enge Korrektur

`buildFingerprint` behält für den eigentlichen `.next`-Baum die feste Grenze `<100.000`. Inhalte aller gefolgten externen Pakete teilen eine zweite feste Grenze `<100.000`; wiederholte logische Aliase verbrauchen erneut dieses gemeinsame Paketbudget. Das erweitert das zulässige Gesamtbudget bewusst auf weniger als 200.000 Einträge zweier getrennter Bereiche. Kein Budget wird je Alias neu gestartet.

Dateiauswahl, sortierte DFS-Reihenfolge, alle externen Assetbytes, Link-Tupel, exakte Alias-/Ziel-/Manifestvalidierung und Native-Descriptor-Bindung bleiben unverändert. Es gibt keine Inode-Deduplizierung oder Auslassung großer Teilbäume. Die bestehende Begrenzung auf acht Handles und acht 64-KiB-Puffer bleibt erhalten. Ein eigenes Tiefen-/Gesamtbytebudget wird mit diesem Schnitt nicht behauptet.

GitNexus meldet mit eindeutigem Dateikontext HIGH: acht direkte Aufrufer, insgesamt 59 erreichbare Symbole, keine zugeordneten Prozesse. Der erste reine UID-Aufruf lieferte ein unvollständiges Nullergebnis; die dateigebundene Analyse und Symbolkontext liefern die tatsächlichen Aufrufer. Die Risikowarnung erfolgte vor der Änderung.

## Tatsächliche Gegenproben

- Neuer Budgettest auf unverändertem altem Helfer: `23364`, Exit 1, genau die ursprüngliche 100k-Assertion. Mit der engen Korrektur: `42521`, Exit 0.
- Der neue Test verwendet virtuelle große Verzeichnisinventuren, aber echte Handles und vollständige echte Payload-Lesevorgänge je ausgewähltem logischem Pfad. Er prüft einen unabhängig konstruierten vollständigen Digest über 90.000 JS- und 11.000 Paketdateien, letzte Byteänderungen in beiden Bereichen, zwei gemeinsam überlaufende Pakete, mehrfach vollständig gebundene Aliase desselben Pakets, die unveränderte Compiled-Grenze inklusive unselektierter Dateien sowie Handleabschluss nach Ablehnung. Seine Metrik zählt die virtualisierten Payloadhandles; die unveränderte bestehende IO-Folge prüft alle Hasherhandles und Fehlerbereinigung.
- Unveränderte serielle Fingerprint-/IO-Regression: `93883`, Exit 0. Unveränderte Native-Artefaktfolge: `23437`, Exit 0, 58 tatsächliche Dateisystemgruppen. Unveränderte QA-Guards: `54486`, Exit 0.
- Scoped ESLint: `8746`, Exit 0, keine Warnungen. Vollständiges cachefreies TypeScript mit 8 GB: `72867`, Exit 0. Der erste Aufruf mit Node-Standardheap (`98225`) endete nach Speichererschöpfung mit Exit 134 und wird nicht als bestandene Prüfung gezählt.
- Lesende Prüfung des tatsächlich zuvor gebauten Artefakts mit korrigiertem Root-Helfer: `33257`, Exit 0; Build-ID `build-TfctsWXpff2fKS`, Fingerprint `9b2cf35db67e84a71996aecb0b5387c62531c5302d1986840f42e44bf490b707`. Dabei wurde kein Buildbeleg erzeugt. Dies ersetzt keinen frischen Originalbuild nach Commit/QA-Abgleich.

Geprüfte Helferbytes: `62a43d597f3e251cd3a7c793fe559194d187740e66951544203571ea6d6096cb`; neuer Test: `4132f20115d1b04e81c9e6dd58822a88b4021dacc271ef961fafae68ce996510` (je SHA-256). Die eingefrorene serielle Referenz wird nicht umgeschrieben.

Als nächster Abschluss folgen frische saubere Root-/QA-Quellenbindung, der originale Produktionsbuild und die gemeinsame 16-Fälle-Browserfolge samt unabhängigem Ressourcenabschluss. Der neue Prüfhelferpin wird in einer frischen Vorbereitung offen gebunden; ursprünglicher fehlgeschlagener Lauf und alte Vorbereitung bleiben unverändert erhalten. Die übrigen Supervisor-/Native-Pins und Artefakt-/Quellen-/Exit0-Guards bleiben gleich. Review Center und Datei-Undo bleiben ausgeschaltet.

Nachfolgender tatsächlicher Stand: Quellenprüfung `78378`, originaler Build `75580` und separater Artefaktabgleich `86762` bestehen jeweils mit Exit 0 auf Root `afb1e65d8` / QA `f5ed169eb`. Die gemeinsame Browserfolge endet anschließend mit Copy5/6 und einem mobilen HTTP-409-Fehler; zehn weitere Fälle starten nicht. Originale, Diagnosegrenze und separat erfolgreiche eigene Bereinigung stehen im [aktuellen Browsernachweis](./yjs-file-actions-browser16-first-evidence.md). Der Artefaktinventurfix ist dadurch im echten Build bestätigt; die Dateiaktionsabnahme bleibt offen.
