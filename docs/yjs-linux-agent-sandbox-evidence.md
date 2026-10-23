# Linux-Abnahme der Agenten-Sandbox

Stand: 20. Oktober 2026. **Der verpflichtende Linux-CI-Teilschritt von M2 ist abgenommen.** Er aktiviert den Dokumentkern noch nicht und ersetzt weder den finalen Produktionsbuild noch M3. Dateiaktions-Undo und Review Center bleiben aus.

## Tatsächlicher RED und begrenzte Korrektur

Der neue Workflow `.github/workflows/agent-sandbox.yml` läuft für jeden Pull Request ohne Pfadfilter, zusätzlich für Main und manuell. Er verwendet Ubuntu 24.04, Node 26, `/usr/bin/python3`, fest gepinnte Checkout-/Node-Actions, ausschließlich Leserechte und keine gespeicherten Checkout-Credentials. Linux und die Pythoninstallation sind zwingend; die tatsächlichen Shell-/Skilltests dürfen weder überspringen noch Fehler unterdrücken. Ein Container wird dafür nicht gebaut.

[Der erste echte Lauf 39350316695](https://github.com/canvascoding/canvas-notebook/actions/runs/39350316695) auf Head `124d939787a9bcf12c1a103a3f47bf8daad395b1` beendet Installation und echten Shelltest erfolgreich. Der tatsächliche Skillprozess scheitert unter Node 26.12.0 mit `ERR_INVALID_PACKAGE_CONFIG`: Das Lesen der Anwendungspaketdatei außerhalb des erlaubten Skillroots wird verweigert. Dieser Lauf bleibt rot erhalten.

Node prüft beim absoluten CommonJS-SDK-Import zunächst die Paketmetadaten des aufrufenden Skripts. Für das im Anwendungspfad liegende Testpaket führt das zur öffentlichen `appRoot/package.json`. Die Korrektur ergänzt im bestehenden Nodearm von `runtimeInstallation` ausschließlich diese Datei über den vorhandenen kanonischen Regular-File-/Symlink-Check. Die lesbaren Verzeichnisse werden nicht erweitert. Ausführungsrechte werden weiterhin ausschließlich aus Runtime und ermittelten Bibliotheken gebildet; das Manifest gelangt auch bei einem App-Root mit `ld-linux` im Namen nicht in diese Auswahl. Pythonarm, Landlock-/Seatbeltmechanik, Seccomp, Netzwerk-/Kindprozesssperren und Schreibrechte bleiben unverändert.

Das feste öffentliche Anwendungsmanifest ist damit auch direkt für den Skill lesbar. Private Elternmanifeste außerhalb des tatsächlichen Skillroots werden ausdrücklich nicht gesucht oder freigegeben. Eine SDK-eigene Paketdatei allein würde die Metadatensuche vom aufrufenden Skript aus nicht schließen.

## GREEN und Quellenbindung

[Der zweite echte Lauf 39351304661](https://github.com/canvascoding/canvas-notebook/actions/runs/39351304661) auf Head `2f3804e6c98c2250cef6e611f3cbd48d82d549aa` besteht vollständig: Installation, harter Linux-/Runtimecheck, tatsächlicher Shelltest und tatsächlicher Skillprozesstest jeweils erfolgreich. Tatsächliche Runtimes: Linux x64, Node **26.12.0**, Python **3.12.3**.

Der Shelltest bestätigt 72 verweigerte Python-/Node-Mutationen und vier verweigerte Shell-Scene-Schreibversuche; direkte Prozesse, Kindprozesse, erlaubte Scratchausgabe, Abbruch und tatsächliche Linux-Seccompregeln bestehen. Der Skilltest bestätigt echte Node-/Python-RPCs, unveränderliche Pakete, verweigerte fremde/sitzungsfremde Lesezugriffe, Netzwerk-/Prozesssperren, Scratch-, Widerruf-, Abbruch- und Protokollgrenzen.

Eine zusätzliche echte Nodeprobe verwendet einen eigenen Skillroot außerhalb des Repositorys mit eigenem Manifest. Sie lädt denselben SDK und führt drei echte RPC-Anfragen aus; Paketdateien bleiben unverändert, private Elternmetadaten samt Verzeichniszugriff bleiben gesperrt. Alle bisherigen Testquellen einschließlich der ersten beiden Proben und ihrer sechs Aufrufe sind bytegleich erhalten.

Checkout und tatsächlicher CI-Mergestand sind separat geprüft: `f9a9d49ea82e69421ee4d671a60aeb7b8d0d7970` ist im vollständigen Checkoutlog enthalten. Sein Git-Baum `e8210e09220a8b15529169f7bbe29121f801b8b7` entspricht exakt dem lokalen Rootbaum des genannten Heads; Mainbasis ist `1506927038b80036749266a56fb769dcb6e6d18c`.

| Endgültige Quelle | SHA-256 |
| --- | --- |
| `.github/workflows/agent-sandbox.yml` | `be92bf2a3a366b959a280e551fe094ef1b2acb5af646a9d37e9d649cc345f4ac` |
| `app/lib/skills/script-runtime/process.ts` | `4ebfcfc96d2630ffd2f882b31f8cedd288f0a78db2d26ef98f530c31ec006297` |
| `scripts/skill-script-process-test.ts` | `8108382eca67cb5063fd700c18841383a71ae0db4089dc059683fe22df3bd19e` |

Die getrennte finale lokale macOS/arm64-Abnahme beendet Typprüfung mit Exit 0 nach 18,140 Sekunden, Scoped-ESLint mit Exit 0 nach 1,602 Sekunden und den vollständigen Skillprozesstest mit Exit 0 nach 8,681 Sekunden. Ihr vollständiger Vorher-/Nachher-Quellcensus bleibt unverändert; eigene Repository- und externe Paketfixtures sind danach tatsächlich abwesend. Dieser macOS-Lauf wird nicht als Linuxnachweis gerechnet.

## Originale und Grenzen

Private Originale: `/var/folders/bx/tjzzmjhn2qdcdyfc_l7hkv900000gn/T/canvas-m2-linux-sandbox-v1nt3pw_`. Vollständige CI-Logs und API-Metadaten bleiben neben dem lokalen Quellcensus und Ressourcenabschluss erhalten.

| Original | SHA-256 |
| --- | --- |
| `first-ci-run.json` | `6429911ddbc8e0d2cfb66c5cb69e27c4e12e5a8c8a0147ce44bf26b7e1a20407` |
| `first-ci-failed.log` | `f5d1c2e72e184521c682c7153438bb816babf864b62e7fb9f46d1e6ba0423623` |
| `first-ci-full.log` | `2b7f6b79f54cc397a156c6b3af91a676128398629bcf264992c551783fced4a6` |
| `final-ci-run.json` | `4c0fbad09cb02a855547b50f78e2c66cb4292e71a0f845591680c11f59f548d0` |
| `final-ci-full.log` | `fd59ece62dbb7322bf0ba59aba2073c2ec1db17ae5d08b6da6dd0a9e0a8b0d07` |
| `final-ci-merge-source.json` | `fd77375c3d2ff63d77c554ba1f01e8e6db73519d6096a10d31b60a251b06a1e4` |
| `local-final/terminal.json` | `3a1b5d9e7b14e638ec262f9f7490772f02a0648c24951fbff174e6d658c049ec` |
| `local-final/source-start.json` | `f10b952241e1af7fae794bbd621b21f8286cc765b828f91e48c87f654ef39797` |
| `local-final/skill-process.log` | `0cea9d1b558bfd3b1d70ee9388783f754900c259bc4d2b80aa74fe5f32fa219b` |
| `local-resource-closure.json` | `017dc0593d6e5e0351618dfe61ac866b801cf2699772f5007904ec3e8497f225` |
| `managed-services-unchanged.json` | `35e46ba77b5dad719578dd92205bc44dd9cbd2ac05004f505b0ad1fb660e9c6d` |

Die vier bestehenden verwalteten Dienste haben unveränderte Container-IDs und sind gesund; kein lokaler Container wurde gebaut, neu gestartet oder hinzugefügt. Die Tests dieses Schritts benötigen keine Datenbank und geben keine zusätzlichen Workspace-Schreibrechte frei.

Der Workflow ist ein zwingendes Gate für diesen Main-Merge. Die frisch gelesenen GitHub-Regeln erzwingen bisher lediglich Lösch-/Force-Push-Schutz; ein serverseitig als required konfigurierter Statuscheck wird nicht behauptet, globale Repositoryeinstellungen wurden nicht geändert. Weitere CI-/Reviewbefunde und die aktuelle Headfreigabe bleiben gesondert zu prüfen.

Diese Abnahme belegt den tatsächlichen GitHub-Linuxrunner und die genannten Quellen, keinen bereits ausgelieferten Produktionskernel oder Container. Unterstützte Plattformen bleiben bei fehlender Isolation geschlossen. Für M2 fehlt weiterhin die kontrollierte Aktivierung unter den dokumentierten Schema-/Writer-/Room-Voraussetzungen; M3 umfasst frischen aktivierten Build und gemeinsame Browser-/API-/MCP-/Dateiaktionsabnahme einschließlich Copy, die beiden alten roten Regressionen sowie vollständiges PR-/CI-/Review. Der [MVP-Plan](./yjs-document-authority-mvp-launch-plan.md) bleibt maßgeblich.
