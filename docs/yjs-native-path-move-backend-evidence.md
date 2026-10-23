# Atomare physische Grundlage für native Move-/Rename-Jobs

Stand: 16. Oktober 2026. Codecommit Root `7b408293fb7da79fe443da8213a63e50892a9257`, QA `8bef32d60a3fc082adfe78c14947f40f4bac3998`. Diese Etappe ergänzt die physische Grundlage des [nativen Pfadplans V3](./yjs-native-move-plan-evidence.md). Sie schaltet dessen Ausführung noch nicht frei. Dateiaktions-Undo und Review Center bleiben ausgeschaltet; kein Produktionsrollout.

## Verhalten und Grenze

`getFdPathMoveBackend().renameNoReplaceAt(sourceParentFd, sourceName, targetParentFd, targetName)` verschiebt eine sichere reguläre Datei oder ein sicheres Verzeichnis relativ zu den gehaltenen Eltern-FDs. Linux verwendet ausschließlich `renameat2(RENAME_NOREPLACE)`, macOS ausschließlich `renameatx_np(RENAME_EXCL)`. Ein belegtes anderes Ziel bleibt unverändert. Fehlende Betriebssystem-/Dateisystemunterstützung und `EXDEV` werden abgewiesen; es gibt keinen gewöhnlichen Rename-, Link/Unlink-, Compiler- oder Copy/Delete-Fallback zur Laufzeit.

Die Raw-Schnittstelle ist jetzt API2 mit sieben Methoden und elf unveränderlichen Exportfeldern. Die bisherige öffentliche Publication-Schnittstelle bleibt API1 mit ihren sechs Methoden; das neue Move-Objekt ist davon getrennt. Bestehende private Unlink-/Regular-Grenzen bleiben erhalten, einschließlich höchstens zwei Hardlinks bei regulären Quellen. Gleicher exakter Name im selben tatsächlichen Elternverzeichnis wird explizit abgewiesen: macOS lieferte dafür sonst einen erfolgreichen No-op. Eine reine Änderung der Groß-/Kleinschreibung kann der Kernel zulassen; die Tests prüfen dabei den exakten neuen Eintrag und dieselbe ursprüngliche Identität.

Die Quellenprüfung unmittelbar vor dem Syscall ist **keine atomare Source-Inode-CAS**. Der künftige Job-Owner muss Schreibzugriffe ausschließen, Root-/Quellen-/Unterbaumbelege halten, ein dauerhaftes Intent vor physischer Änderung bestätigen, die tatsächlichen Eltern synchronisieren und ungewisse Ergebnisse wiederaufnehmen. Diese Primitive allein erteilt weder Autorität noch eine Durability- oder SQL-/Yjs-Abschlussbestätigung.

## Auslieferung und Buildbindung

- Build/Verify erzeugen und prüfen ein plattform- und architekturspezifisches Node-API8-Modul für Linux/macOS arm64/x64 mit strengem API2-Manifest und tatsächlichen Quell-/Binärhashes. Zur Buildzeit werden nur bereits installierte Compiler und Node-Header verwendet.
- Der Docker-Builder enthält den Compiler und baut das Modul auch beim Import eines vorgebauten Next-Artefakts selbst. Der Runner kopiert und verifiziert Modul und C-Quelle. Hostartefakte bleiben durch `.dockerignore` ausgeschlossen.
- Das architekturunabhängige Releasearchiv bleibt unverändert frei von nativen Binärdateien. Die Next-Dateiverfolgung erfasst den jeweiligen nativen Plattformpfad.
- Der QA-Sourcefingerprint bindet jetzt zusätzlich die C-Quelle. Der QA-Buildfingerprint bindet nach dem bisherigen Next-Digest die vollständigen Bytes von Manifest, Quellkopie und Binary, prüft ihre SHA-Bindung sowie Dateiprofile/Eltern und verweigert fehlende oder unsichere Artefakte. Die ursprüngliche Serial-Referenz und ihre Fixtures bleiben unverändert. Die maßgebliche Prüfung ist der vollständige `assertBuildProof`-Pfad.

Es wurde kein Docker-Image gebaut, kein neuer Stack gestartet und nichts nach Produktion veröffentlicht. Die Verpackung ist quellgeprüft; ein tatsächlicher Imagebau ist damit nicht abgenommen.

## Tatsächliche Prüfungen

| Prüfung | Ergebnis |
|---|---|
| Neue echte macOS-arm64-Matrix, Node 26/UID501 | Facade und frischer Raw-Prozess mit jeweils neun Familien bestanden; reale Dateien/gefüllte Ordner, originale Inodes/Bytes, umbenannte Eltern und neue Pfadaliase, belegte Datei-/Ordner-/Symlink-/Hardlinkziele, strikte Eingaben und vier echte Worker-Rennen. |
| Neue Linux-arm64-Matrix, vorhandene Orb-Maschine, Node 22/UID501 | Unverändertes finales Build/Verify und dieselbe vollständige neue Matrix bestanden, einschließlich tatsächlichem `EXDEV` gegen `/dev/shm`. |
| Dasselbe Linux-Binary im vorhandenen Notebook-Testdienst, Node 24.18/UID1000 | Unveränderte vollständige neue Matrix bestanden. Nur eine eigene private `/tmp`-Fixture angelegt und entfernt; App, DATA, Konfiguration, Images und Dienste unverändert. |
| Manifestnegative auf beiden Plattformen | Je neun tatsächliche neue Prozesse und gesonderte Builder-Verifikation verweigern fehlendes/fremdes/manipuliertes/aliastes Manifest sowie Quell-/Binärdrift. |
| Bestehende Publication-Regression | macOS alle neun, vorhandener Linux-Notebook-Dienst alle sechs bisherigen Familien bestanden; tatsächlicher 100001-Einträge-Scan, unveränderte private Profile, FDs geschlossen und Fixtures entfernt. Nur die erwartete falsche native API im Manifesttest ist jetzt 99 statt der nun gültigen 2. |
| Native QA-Artefaktbindung | 58 echte Git-/Dateisystemgruppen bestanden: C-Drift, einzelne und kohärente Artefaktwechsel, ursprünglicher Proof, fehlende/Symlink-/Hardlink-/unsichere/leere/übergroße/Verzeichnis-/FIFO-Dateien und unsichere Eltern. Synthetische Binärbytes werden dabei bewusst nicht geladen. |
| Bestehende QA-Schranken und Serialmatrix | Beide unverändert bestanden. Vollständiges cachefreies TypeScript, Scoped ESLint und Diffprüfung bestehen. |

Das Linux-Binary wurde in der vorhandenen Ubuntu-Maschine kompiliert und im vorhandenen Debian-Notebook tatsächlich geladen. Der manuelle überlaufgeprüfte uint64-Parser vermeidet die durch neuere Linux-Header eingeführte `__isoc23_strtoull`-Abhängigkeit. `readelf` bestätigt nur GLIBC2.17/2.28/2.33. Binär-SHA256: `dd0298e499489ccf7662412a63b8b60929b0989de20f9bfe3ba3ab4093e76ad7`. x64 und privilegierte Fremd-UID-Fälle sind nicht ausgeführt.

Die Linux-Nachweise liegen privat unter `~/.local/state/canvas-fd-move-linux-w4a37fc4`: Compilebericht `c3160eecc8645c1b4a0e3f9526b5d329b8a4d9b702e9a29e7af61973d309ec6f`, Orbmatrix `ce66f9e13540fceaf49ecf63d7057281bbbd8e17945dafe663d74edbda4bba26`, Notebookmatrix `6fb13351b8f7b7b45720ddde6239df94bca6d07733883379f8631c7754a73e5b` und frischer Ressourcenabschluss `5471e7752ca643503ae8e8eb58a6435b42c3eb9b64444e083b71844f79c94089`. Die ursprünglichen Darwin-/Linux-Publicationläufe liegen im privaten Prüfordner `canvas-atomic-path-move-egm2b_a0` mit tatsächlichem Exit 0.

## Frischer Produktionsbuild

Der unveränderte Originalsupervisor beendet den Produktionsbuild mit tatsächlichem Exit 0. QA-Head `8bef32d60a3fc082adfe78c14947f40f4bac3998`, Source `027241295e28646818b4654167fa6f92374d4cfe2ed6f0b03659ec3e8c2ca7ba`, Build `c47d21fef19ec951b486404c4463cf5b8c624dc87c95a8ac0953f47fdef78560`, Proof-SHA256 `e077fdb9f073da4940693f08d43c974af4e17be973cd3d275f3eac941fdedd5e`. Die Build-ID `build-TfctsWXpff2fKS` ist kein Einzigartigkeitsbeleg.

Unabhängige Vorprüfung und Nachbuild-/Vorruntime-Prüfung bestätigen alle zehn Commitdateien, die ursprünglichen Supervisor-/Serial-/Guard-/Release-/Browserdateien und genau die drei bekannten Root↔QA-Differenzen. Patch-SHA256 bleibt `b3c69c58e362e44bd5945415de80ec45537f5b67c41949020f78107cfc6997d4`. Vorprüfung `935898e7ab6b91da02846035799feed156a23e295167925f929e259568fb33d9`, Nachbuildprüfung `9dfb9d091fc810478c8d6696093bf7b58cb862faac0742bd6f23671f9a67b38a`. Die neue native Bindung ist tatsächlich geprüft; die Aussagen beziehen sich ausdrücklich auf den geänderten QA-Helper.

## Tatsächliche fokussierte Browserregression und Abschluss

Nach dem frischen Build beendet der unveränderte Originalsupervisor die ausgewählte Folge mit tatsächlichem Exit 0: **4/4**, keine Fehler, Skips, Testtimeouts oder Unterbrechungen. `workspace-file-undo-disabled.spec.ts` besteht 2/2 auf Desktop/Mobile mit tatsächlichem Markdown-/TXT-Delete, fehlender Undo-Aktion und vier verweigerten historischen API-Zugängen. `workspace-starter-initialization.spec.ts` besteht 2/2 für die reguläre Dokumentanlage. Die Auswahl prüft die bestehende Publication-Nutzung bei der Dokumentanlage und die aktuelle Undo-Abschaltung; sie ist ausdrücklich keine Abnahme neuer Move-Ausführung.

Der erste Startversuch endet bereits vor der ersten Runtime-Gate mit Exit 1, weil Root die vom unveränderten Supervisor verlangte `CANVAS_YJS_AUTHORITY_RUNTIME_START=1` noch nicht gesetzt hatte. Der zweite Lauf setzt diese vorgesehene ausdrückliche Startfreigabe; Quellen, Supervisor, Specs und Assertions bleiben unverändert. Beide Originallogs bleiben erhalten. Dies ist kein Produktfehler und wird nicht als fehlgeschlagener Browserfall ausgegeben.

Frische unabhängige Nachprüfung bestätigt denselben vollständigen Build-Proof einschließlich C-Quelle/native Artefakte, dieselben separaten Source-/Buildfingerprints, alle Quellpins und exakt die bekannten drei Worktree-Differenzen. Nachruntime-Audit-SHA256: `4a21587716f5a722c11d37dda83fd640428ecc2f2d10e81f767f5c43b1b48ed8`. Die beiden unveränderten Originalbrowserberichte besitzen jeweils SHA256 `1dcb0183f5e2385389c0d20c8ef9fb279c7cac99dc49dad1be49177da83bdce5`. Der Originalreceipt ist `cleaned/passed`, ohne Ungewissheit; SHA256 `17285922abbeeb7b307aa80857fda4ddf1344e80abbb9dee08f57c931b21deca`.

Root bestätigt danach zusätzlich mit einer eigenen frischen Read-only-Prüfung: beide eigenen Datenbanken fehlen nach Name und ursprünglicher OID, es bestehen keine zugehörigen Sessions; der eigene Pool ist geschlossen. Erfasste eigene PIDs/Gruppen, alle drei eigenen Ports, Runlock, DATA und temporäre Runtime-Dateien fehlen. Drei verwaltete HTTP-Dienste antworten 200. Originalreceipts und Browserberichte bleiben bytegleich. Abschluss-SHA256 `492c86500d40dfabe502eb5968102058a6cf9c719f81327f159556260fa9b104`, privat unter `canvas-yjs-authority-nm0Zx4/successful-closure-verification.json`. Keine fremden Dienste beendet und keine weiteren Datenbanken entfernt.

## Verbleibender Anschluss

V3 bleibt `executionReady: false` und außerhalb des ausführbaren Producer-/Executor-Vertrags. Weiter erforderlich sind der gehaltene Quellen-/Unterbaumvertrag einschließlich tatsächlich fehlender Projektion, ursprüngliches Intent und Recovery, der echte Job-Owner, native Pfad- und Linkänderung mit Nebenwirkungen auf derselben autorisierten Verbindung sowie die Abnahme regulärer Move-/Rename-/Copy-Vorgänge. Native-only und nicht verlustfrei exportierbares Rich dürfen dabei nicht in Dateibytes umgedeutet werden.

Die browsergestützte Prüfung der neuen Move-Ausführung sowie die gemeinsame API-/MCP-/SDK-/Such-/PDF-Gesamtabnahme bleiben offen. Dateiaktions-Undo wird weder repariert noch freigeschaltet; normales Text-Undo im Editor bleibt getrennt.
