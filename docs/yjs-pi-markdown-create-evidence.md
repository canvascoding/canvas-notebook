# Interne PI-Markdown-Neuanlage

**Aktueller Teilabschluss: Die interne PI-Neuanlage ist lokal abgenommen.** Der finale echte Lauf `run11-final-runtime` besteht zwölf Familien sowie Typecheck und Scoped-ESLint. Neue interne Agenten-Markdown-Dokumente sind im MVP auf 1 MiB UTF-8 begrenzt. Linux-/CI-Schreibschutz, Produktionsaktivierung und M3-Gesamtabnahme bleiben offen; Root-Aktivierung, Dateiaktions-Undo und Review Center bleiben aus.

Die folgenden Ausgangspunkt- und RED-Abschnitte sind historische, an ihre jeweiligen Quellen gebundene Belege. Der aktuelle Abschluss folgt am Ende.

Stand: 20. Oktober 2026. Arbeitsbasis Root `8bd8d3376b403e1e973fa4cb3eaea75e5b1863ad`. **Offene M2-Produktlücke tatsächlich reproduziert; Korrektur und Gesamtfreigabe noch nicht abgenommen.** Produktionsaktivierung, Dateiaktions-Undo und Review Center bleiben aus.

## Erhaltener tatsächlicher RED

Der neue Test `scripts/pi-markdown-create-postgres-test.ts` ruft `writeAgentTextFile` aus einer tatsächlich gespeicherten PI-Sitzung auf. Ein echter eingeschränkter Agent besitzt einen aktuellen Workspacegrant; der normale gespeicherte Kontext und die tatsächliche `AgentToolInvocation` mit Toolname `write` bleiben unverändert. Es werden keine Ziel-Native-, Receipt-, Birth- oder Projektionszeilen vorbereitet und keine Actor-DTOs als Berechtigung verwendet.

Der Aufruf meldet Erfolg; Originalbytes, SHA-256 und Größe stimmen. Die anschließende gemeinsame Beobachtung findet jedoch **Registry 1 / unveränderlicher Importbeleg 0 / Create-Bindung 0 / Projektion 0**. Der ursprüngliche Test scheitert an genau der Anforderung, dass eine erfolgreiche zentrale Anlage jeweils einen vollständigen Bestandteil besitzen muss. Tatsächlicher Originalexit: **1**, nach 13,020 Sekunden. Kein erfolgreicher Create-/Import-/Read-Abschluss wird daraus behauptet.

Der Baseline-Test hat SHA-256 `43868a10f4f824b902b4e8913cfa9474ba179193f76db8aecdbee725678bd6b2`, der awaitete Entry `079e4adc3ca86832f58487725250bc5f4d6393a063dbcea5ffa760b58d11357f`. Der gemeinsame feste ESM-Runner erhielt ausschließlich einen zusätzlichen Entry und 23 tatsächliche Pflichtquellen; seine Ausführungs-/Cleanupmechanik blieb gleich. Während dieser Gegenprobe sind alle Produktquellen identisch zum genannten Root-Commit; nur die beiden Testdateien und der feste Runner-Eintrag sind ergänzt. Vollständiger Quellcensus vor/nach bleibt bytegleich.

Unabhängig geprüft: eigenes Schema/OID, Sitzungen, DATA, Originalprozess und Bundleverzeichnis entfernt; dieselben vier verwalteten Dienste bleiben gesund. Kein Container wurde gebaut oder neu gestartet.

Private Originale: `/private/var/folders/bx/tjzzmjhn2qdcdyfc_l7hkv900000gn/T/canvas-m2-pi-create-8gqphdcr/baseline-red`.

| Original | SHA-256 |
| --- | --- |
| `terminal.json` | `0086ac69a5270f00bf1d79b3de1b5833fc237d475c99aa635a0b4c6797b12cef` |
| `pi-create.log` | `4eef234f44f75ad6e43a44e9623537fce08faf2c21cab3a3f4ca849d85620905` |
| `pi-create-resources.json` | `cb218f6a3d632e8070f4fa06b64e219e47346b7cd1b8881d056e2581f0c6257e` |

## Erforderliche Korrektur und Abnahme

Der interne Agent muss als dritter echter Invocationarm in denselben vorhandenen zentralen Create-/Import-/Birth-/Projektionskern wie Web und MCP eintreten. Aktuelle echte PI-Autorität und feste Toolpolicy bleiben getrennt von historischen Originalfakten. Ein stabiler callergebundener Schlüssel erhält die ursprüngliche Operation über verlorene Antworten und erneuerte Sitzungen. Vorhandene Native-Identitäten bei fehlender/leer gewordener Markdownprojektion dürfen keine zweite Anlage oder rohe Schreibumgehung erzeugen.

Erforderlich bleiben der unveränderte Baseline-GREEN, tatsächliche PI-Replay-/Konflikt-/SID-B-/Rechte-/Toolpolicy-/Quellenprofile-/Projektionsgegenfälle und gezielte unveränderte Web-/MCP-/Principal-/Birthregressionen. Die passende frische kompilierte Browserabnahme des aktivierten Gesamtstands bleibt M3. Linux-/CI-Schreibschutz und kontrollierte Aktivierung sind weitere M2-Schritte. SDK-/PDF-Konverter-/Such-/Skill-Erweiterungen werden mit dieser Korrektur nicht als fertig erklärt.

## Fortschreibung anhand der erhaltenen Originalläufe

Entwurfsstand nach `run08-static-and-pg12`, vor der abschließenden MVP-Abnahme. Die vorstehenden Originalabschnitte bleiben als historischer Ausgangsstand unverändert. Die folgenden Angaben stammen aus tatsächlich beendeten Root-Läufen; ein privater Quellkandidat oder ein unabhängiger Quellreview wird nicht als ausgeführte Abnahme gezählt.

Gemeinsames privates Originalverzeichnis: `/private/var/folders/bx/tjzzmjhn2qdcdyfc_l7hkv900000gn/T/canvas-m2-pi-create-8gqphdcr`. `preserved-reds.json` hält Baseline sowie run02/run05/run06/run07 mit Originalexit, vollständig unverändertem Quellcensus und unabhängigen Ressourcenprüfungen fest; SHA-256 `ab9d0c524917336439eb71a3e6dbbe798d737897280196b12f38b24e7353cb00`. run08 wird durch seine eigenen `terminal.json`, `pi-create.log`, `pi-create-resources.json` und `source-start.json` ergänzt.

| Lauf | Tatsächlicher PI-Exit / Laufzeit | Abgeschlossene Familien | Festgestellter Stand |
| --- | --- | --- | --- |
| `baseline-red` | 1 / 13,020 s | 0 | Schreibaufruf erfolgreich, aber nur Registry 1 / Importbeleg 0 / Birth 0 / Projektion 0. |
| `run02-pg7` | 1 / 27,552 s | 1 | Erste echte zentrale Anlage vollständig; gleichlautender Replay scheitert am Importfingerprint. Zugleich verändert der Settingsleser die Verzeichnis-ctime; das vollständige FD-Orakel schlägt an. |
| `run05-drift-red` | 1 / 29,592 s | 3 | Anlage, Replay/Konflikt und SID-B einschließlich tatsächlichem Core-Tool-Replay bestanden. Stopp an einer falschen erwarteten Fehlerklasse des ACL-Tests; die tatsächliche Rechteverweigerung bleibt NoWrite. |
| `run06-final-drift-red` | 1 / 49,314 s | 5 | Zusätzlich echte Rechte-/Toolpolicy- und Inhaltsprofilfälle bestanden. Stopp am falschen Fixture-Orakel „Webupload-Birth 0“; der echte Upload besitzt bereits Birth 1. |
| `run07-final-drift-red` | 1 / 60,373 s | 7 | Alle sieben kleinen Familien bestanden. Die echte vorübergehende `legacy`-Änderung umgeht die neue Anlage: 26 beobachtete SQL-Anweisungen, davon 6 Schreibanweisungen; alle drei vollständigen NoWrite-Nachprüfungen scheitern. |
| `run08-static-and-pg12` | 1 / 69,326 s | 8 | Derselbe Test besteht zusätzlich den unveränderten Driftfall mit 0 SQL / 0 Schreibanweisungen und drei erfüllten NoWrite-Orakeln. Danach scheitert die tatsächliche 6-MiB-Neuanlage an abgelaufener Principalphase. |

run02 zeigte zwei getrennte Produktfehler. Der Agent-Replayfingerprint muss dieselben ursprünglichen Source-/Originfakten in fester Schlüsselreihenfolge verwenden; die Wiederherstellung aus dem kanonischen privaten Birth darf keine zweite JSON-Reihenfolge in den Vergleich einführen. Außerdem rief der Settingsleser erneut `chmod` für ein bereits korrekt auf `0700` gesetztes Verzeichnis auf und änderte dadurch dessen ctime. Die Korrektur prüft den bestehenden Modus vor einem notwendigen `chmod`. Das FD-Orakel wurde nicht auf bloßen Inhaltshash reduziert. In den nachfolgenden erfolgreichen Replay-Fenstern bleiben vollständige Schema-/OID-/Zeilen-/xmin- und DATA-/FD-Fakten unverändert.

run05 bestätigte eine tatsächliche aktuelle ACL-Verweigerung vor DML: 23 SQL-Anweisungen, 0 Schreibanweisungen, alle drei Nachorakel erfüllt. Der bestehende `assertWorkspacePermission` wirft hier einen gewöhnlichen `Error` mit exakt `Workspace permission denied`, eigenem Code `WORKSPACE_PERMISSION_DENIED` und eigenem Status 403. Nur diese konkrete Testerwartung wurde korrigiert; beliebige Verweigerungen oder andere Fehler werden nicht akzeptiert. run06 korrigierte ebenfalls nur ein konkretes Fixture-Orakel: Der echte Webupload liefert seine ursprüngliche vollständige Birth, die bei späterer PI-Ablehnung unverändert bleiben muss. Er wird nicht als birthloser Seed ausgegeben.

## Tatsächlicher Drift-RED und unveränderter Drift-GREEN

run07 und run08 verwenden beide exakt `scripts/pi-markdown-create-postgres-test.ts` mit SHA-256 `15a88121b7d5abdf529380c018e8a7816170021d322707ad84aa2127511920db`. Der darin unveränderte Driftblock hat SHA-256 `458ead35523b3b78c6b2d6dc6f4c79ac774da2ae271aee3e806e71830509e545`. Ein tatsächlich gespeicherter PI-Kontext startet mit `legacy=false`; nach synchronem Dispatch der echten Schreibfunktion bis zu deren erstem tatsächlichen Pfad-await wird dieselbe ALS-Referenz auf `legacy=true` geändert. Die Referenz wird vor der gewöhnlichen äußeren Abschlussprüfung zurückgesetzt. Kein Pfad-/FS-Verfahren und kein Invocationguard wird im Test ersetzt.

Vor der Korrektur fehlt die erwartete `AGENT_TOOL_INVOCATION_ORIGIN_CHANGED`-Ablehnung; echte Schema- und Dateifakten ändern sich, und das DML-Orakel zählt sechs Schreibanweisungen. Nach der Korrektur wird der genuine Invocation-Ursprung über den Pfad-await festgehalten und vor einer geänderten Eligibility-/Rawentscheidung geprüft. Genau derselbe Test erhält die erwartete Ablehnung ohne SQL oder irgendeine Veränderung an Schema/DATA. Die vollständigen Nachprüfungen laufen auch beim fehlerhaften Aufruf bis zum Ende.

Die erhaltenen Quellcensus-Dateien binden `agent-file-operations.ts` in run07 an `6a2c6c66a83226d807440d7d2e49775dffad760a11efdb28bb07e797677cfe3b` und in run08 an `ce0c6303ae03703dcec33b2743c97c867dd2457f40c6e8dc60e51219cd6a905d`; die Testdatei bleibt identisch. Der gemeinsame Settingsstand ist in beiden Läufen `1246ef9ea94194e256054f47eb838de806b2813b7aef1dc294f430d5cbaa7693`.

Die acht abgeschlossenen run08-Familien belegen: genuine zentrale Neuanlage mit ID/Lineage/Beleg/Birth/Projektion und ID-Read; expliziten Schlüssel-Replay samt Konflikt und Originalattribution; genuine SID-B und tatsächliches Core-Tool-Schlüsselrouting; aktuelle ACL und Toolpolicy; leeres Dokument und vollständige BOM-/CRLF-/Frontmatter-Quelle; vorhandene Rawquelle und fehlende/0-Byte-Nativeprojektionen ohne Doppelbirth; denselben bereits geparsten Text über eine echte `pdf_to_markdown`-Invocation; sowie den korrigierten Origin-Drift. Dies ist kein PDF-Konversionstest und kein Widerrufstest der alten PI-Sitzung.

## Erhaltene Größenbegrenzung statt behaupteter 6-MiB-Erfolg

run08 besitzt tatsächliche Typecheck- und Lint-Exits 0. Sein PI-Test bleibt insgesamt **Exit 1, `complete:false`**. Die anschließende echte Quelle umfasst 6.291.532 UTF-8-Bytes; das escaped Source-JSON umfasst 12.582.992 Bytes und schon der tatsächliche Base64-Prepare-Feldteil 8.388.808 Bytes. Der öffentliche Fehler ist `MARKDOWN_IMPORT_COMMIT_UNCONFIRMED`; die erhaltene Ursache enthält `MARKDOWN_CREATE_BIRTH_CLOSURE_FAILED` und `PRINCIPAL_EXPIRED` aus der unveränderten fünfsekündigen OnConnection-Grenze.

Damit ist weder ein erfolgreicher 6-MiB-Create noch ein erfolgreicher 6-MiB-Read/Replay belegt. Aus anschließendem Test-Teardown wird auch **kein fachlicher Rollback oder Nicht-Commit der begonnenen Anlage** abgeleitet. Die tatsächliche Fehlerkette bleibt erhalten. Die späteren ACK-/TEMP-/Encoding-Familien dieses Laufs wurden nach dem Größenstopp nicht erreicht.

Für das zeitnahe MVP ist deshalb eine explizite Grenze von **1 MiB / 1.048.576 UTF-8-Bytes ausschließlich für frische PI-Markdown-Neuanlage** vorgesehen. Die Grenze muss nach Lookup der ursprünglichen Birth und nach tatsächlicher Native-/Physicalklassifikation liegen: passende gespeicherte Historie wird zuerst geprüft; vorhandene reguläre Dateien behalten den bestehenden Rückweg; initialized Nativeziele mit fehlender/0-Byte-Projektion behalten ihre Lifecycleverweigerung. Nur der verbleibende frische abwesende Zielpfad wird vor Birthinitialisierung begrenzt. Es gibt kein Abschneiden, keine Schlüsselrotation und keinen Rawfallback.

Die bisherige 8-MiB-Capture-/Historicalgrammatik und die Grenzen anderer Web-/MCP-/Edit-/Temp-/Nicht-Markdown-Arme werden dadurch nicht zu einer akzeptierten 8-MiB-Ausführung umgedeutet. Größere frische PI-Neuanlagen bleiben nachgelagerte Größenarbeit. V8 mit dem tatsächlichen 6-MiB-RED wird unverändert erhalten. V9 ändert ausschließlich die ausdrücklich neue Größenfamilie auf exakt 1 MiB inklusive vollständigem Cursorread/Birth/Replay und mehrbytebasiertem >1-MiB-NoWrite-Gegenfall; die übrigen elf Familien sowie der ursprüngliche >8-MiB-Negativblock bleiben bytegleich. Die damalige V9-MVP-Abnahme war noch offen; ihr tatsächlicher run10-Ausgang und der finale V11-Abschluss sind unten getrennt dokumentiert.

## Originalartefakte, Quellcensus und Ressourcen

Alle folgenden Werte binden die Originaldateien im genannten privaten Verzeichnis. Die fünf frühen Läufe sind zusätzlich durch `preserved-reds.json` zusammengeführt. Jeder Lauf hat tatsächlichen PI-Exit 1 mit Signal `null`; kein fehlender Prozessabschluss wird als Grün gerechnet.

| Lauf | `terminal.json` | `pi-create.log` | `pi-create-resources.json` |
| --- | --- | --- | --- |
| `run02-pg7` | `5efa24be8d0a05287c8a6fc42abc8d0e7ee3ec015bc3977b7784eb1be2679925` | `6ff957c708a55286584a5871c8ca16fb4d793c94bebf90921e2ec1c46b6bde51` | `b3f6e720c580227d0530bcc8e173ea77fc59933817f05f6400abe7d5e1163818` |
| `run05-drift-red` | `2db3ae683b29e93283bab18dafa87c0349befffc8897feb94a8ac455eaaa2d9c` | `e3f910233f0431849ede02db7e9af6037040e0ff4ba077a174285000979b4542` | `3f3a88e7a88a2f81c4adb146a1a09f437513d0671b51ee29321301055113d242` |
| `run06-final-drift-red` | `4ab85d8bed8b56093d674d7f2b3662fa44098ef5312d3757d54279b35a425583` | `97663c792fb5732ef0e3155f338a185e316b8065a1c50355b8fe7fc735b42c7b` | `3bee15a3a1dbb16fbdebb8c0b1127de1ad4e027b7fbc2acdc25abbb01cc4e194` |
| `run07-final-drift-red` | `c84af0cc78e504316440637c1101f5d082a4814882989680d3a7e6407ad2a164` | `fd730d4ecbf71642bebf0098f573607275b8e532e71bacf1e868059ec233b9db` | `f8160bce0332b298e60e55a4cdc8a7b1b8049a6a1e606413f06abd5d3dffad08` |
| `run08-static-and-pg12` | `523cbf732d204aa80a7953a3f4b4ef2d9a568e6b25d11319e20ec5817d0a8b92` | `3f4106d4f61ebff191d1c459549566c3d68b6a607b4c701591a61f3d60ee1929` | `5997394d0272daf0bea5968f1ac3d3e59617835f79c530f1b8a454f7d3e11f36` |

| Lauf | Original `source-start.json` SHA-256 |
| --- | --- |
| `baseline-red` | `aa99ca8b5a7e3bba2863221227a0aab7a5859992489af3be521ff2be8316139d` |
| `run02-pg7` | `72b936a03efbc98c10de67607df5886145f638a38b18b7f0bb4e21793c9652cc` |
| `run05-drift-red` | `170c6be78929f01d6f4bafb968e1f6cc33a7cdbd93c4dcfbb87fd3772e4626b7` |
| `run06-final-drift-red` | `fb0b2693faa5ed54d35353f02044b889c15d6b4178cb816e8cd3873cb5c08cb2` |
| `run07-final-drift-red` | `026cedbc31b645cd8c25fa2648e10e7834411add727e09b3d2c5b6f388ba8470` |
| `run08-static-and-pg12` | `b223267be4ce1214b527c4a402be66d942dbea8a1c34d34f13276b8200d77580` |

Für alle sechs Läufe bestätigen die unabhängigen Ressourcen-JSONs: vollständiger Quellstand vor/nach unverändert; eigenes Schema samt OID und eigene Sitzungen weg; Prüfverbindung read-only ohne vergebenen XID; eigenes DATA und ursprünglicher Prozess weg; dieselben vier verwalteten Dienste gesund. Der Erhaltungsindex bestätigt für die fünf frühen Läufe zusätzlich die unabhängig geprüfte Bundleabwesenheit; run08 protokolliert den tatsächlichen Controller-Cleanup mit `removed:true`. Die Ressourcenfreiheit der isolierten Fixture ist getrennt vom fachlichen Commitstatus des fehlgeschlagenen Größenfalls zu lesen.

## Finaler tatsächlicher Abschluss

`run10-mvp-final` beendet Typecheck und Scoped-ESLint mit Exit 0, den PI-Test mit Exit 1 nach 80,859 Sekunden und elf abgeschlossenen Familien. Exakt 1.048.576 UTF-8-Bytes werden zentral angelegt; der vollständige native Cursorread liefert neun Seiten und 2.097.167 Bytes. Der mehrbytebasierte >1-MiB-Fall und der bestehende >8-MiB-Fall bleiben vor Wirkung gesperrt. Tatsächlicher erfolgreicher COMMIT mit verlorener Bestätigung wird über genau eine ursprüngliche Birth bestätigt; ein echtes initiales TEMP-Tabellenshadowing wird ohne Normalisierung oder native/rohe DML abgewiesen. Der letzte Encodingfall zeigt dagegen, dass die äußere Agenten-Invocation trotz innerer strukturierter Core-Antwort noch verwirft. Dieser rote Lauf bleibt erhalten.

Die Korrektur sitzt ausschließlich nach dem vollständigen Abschluss der echten `withAgentToolInvocation`-Promise im bestehenden Runtimewrapper. Nur genuine bekannte Markdown-Fehler von `write` beziehungsweise `pdf_to_markdown` werden dort in eine begrenzte strukturierte Fehlerantwort übersetzt. Eigene Operations-ID und Idempotenzschlüssel bleiben für eine gebundene Wiederaufnahme sichtbar, private Ursachen bleiben intern. Pfade werden ohne Getter/Proxy höchstens bis 4096 Zeichen angezeigt. Allgemeine Fehler, andere Tools und verletzte Principal-/Invocationregeln werden weiterhin verworfen. Kein Guard und keine globale Frist wurde gelockert.

**`run11-final-runtime`: alle zwölf Familien bestanden, tatsächlicher PI-Exit 0 nach 80,551 Sekunden, Signal null.** Abschließende Typprüfung Exit 0 nach 19,223 Sekunden, Scoped-ESLint Exit 0 nach 2,603 Sekunden. Die echte Encodingprüfung verwendet jetzt den tatsächlichen Runtimewrapper um das echte Core-`write`. Zusätzlich prüft dieselbe Familie vier ausdrücklich reine Transportgegenfälle: sichere Operation-/Schlüsselanzeige eines genuinen Markdownfehlers, unverändertes Verwerfen eines gewöhnlichen Fehlers, unverändertes Verwerfen beim falschen Tool und unveränderte Ablehnung eines tatsächlich vergifteten Invocation-Ursprungs. Der Transporttest allein behauptet keinen dauerhaften Commit; der tatsächliche verlorene Commit-ACK wird separat in Familie zehn geprüft.

Der neue Agentenarm verwendet denselben zentralen Create-/Import-/Birth-/Projektionskern wie Web und MCP und eine echte gespeicherte PI-Autorität. Aktuelle Rechte und feste Toolpolicy bleiben von unveränderlichen historischen Originalfakten getrennt. Ein expliziter Schlüssel ist an Benutzer, Agent und Workspace gebunden; ohne expliziten Schlüssel wird die tatsächliche Toolcall-ID verwendet. Historie wird vor aktueller Pfadbeobachtung gelesen. Bereits vorhandene Dateien behalten den bisherigen Editweg, initialisierte native Dokumente mit fehlender oder leerer Projektion erhalten keine zweite Birth. Die frische 1-MiB-Grenze liegt erst nach dieser Einordnung. Bestehende Edits und historische Replays behalten ihre bisherigen mechanischen Grenzen; größere frische Agenten-Neuanlagen bleiben nachgelagert.

Die finale Zwölferfolge deckt genuine Neuanlage mit ID-Read, unveränderlichen Replay/Konflikt, erneuerte echte SID-B mit Originalattribution, aktuelle Rechte und Toolpolicy, leeren Text sowie vollständiges BOM/CRLF/Frontmatter-Markdown, vorhandene Raw-/Nativeziele, den bestehenden PDF-Helferaufruf mit bereits geparstem Text, transienten Origin-Drift, exakte Größen-/Cursorgrenzen, verlorenen Commit-ACK, TEMP-Schatten und Encoding-/Runtimefehler ab. Vollständige Schema-/OID-/Zeilen-/xmin-, DATA-/FD- und SQL-/DML-Orakel bleiben erhalten. Ein PDF-Konversionslauf oder ein vollständiger Shell-Sandboxnachweis wird dadurch nicht behauptet.

### Gezielte Bestandsregressionen

`run09-regressions` beendet alle elf tatsächlichen Programme mit Exit 0 und Signal null: direktes MCP-Create, manuelles Web-Create, authentifizierte erste Projektion, MCP-Create-Principal, Native-Edit-Principal, Suchtool-Dispatcher, Public-Share-Create, manueller Birth-Eingang, Agent-Invocation, Agent-Runtime-Temp und FD-Publikation. Der volle Quellcensus bleibt innerhalb dieses Laufs unverändert.

Dieser Lauf liegt vor der ausschließlich frischen Agenten-Neuanlage zugeordneten 1-MiB-Grenze und der abschließenden Runtime-Fehlerübersetzung. Die vorhandenen Web-/MCP-/Edit-/Principal-/Birtharme dieser Regressionen wurden damit nicht umgebaut. Er ist deshalb ein gezielter Bestandsnachweis auf seinem eigenen Quellstand, keine behauptete finale Build-/Browserabnahme. Der alte Runtime-Temp-Test besitzt eigenen temporären DATA-Speicher, aber keinen unabhängig inventarisierten eigenen PG-Schemabereich; für ihn wird kein zusätzlicher vollständiger PG-NoWrite-Abschluss behauptet.

### Endgültige Originale und Quellenbindung

Alle Pfade liegen unter dem oben genannten privaten Originalverzeichnis. Jeder terminale Controller protokolliert seinen eigenen vollständigen Vorher-/Nachher-Quellcensus und `unchanged:true`.

| Lauf | `terminal.json` | `source-start.json` |
| --- | --- | --- |
| `run09-regressions` | `2576d4eccc1ee4fdb282a65b024dfee8b44c24d2949e3779881b18ac545dfc00` | `9d282ab24c4943865085e95c0b2a9b0577ce5d9b1857385f809374e0f6a473ea` |
| `run10-mvp-final` | `65b2d70817c816e1451b1e71187e49626913b0fd7a33564ca2fd8c0f4b40ce6f` | `f312d822243440e39eed2c384514f5bdba78832ec716cf6d75138e9ddb4fb64c` |
| `run11-final-runtime` | `067060f507b949a6f0ffe6c37a20ebd50812d792dc974ebd164b272744fde6bb` | `fea753bd5afa048c773fe7309cf3a8f6f5728dfac427fa40854df9f393b509d1` |

| Lauf | `pi-create.log` | `pi-create-resources.json` |
| --- | --- | --- |
| `run10-mvp-final` | `a0591c414f36ace4ca9fbc6e6525131e22ba35525d5e9393df600421da08f9ba` | `1b4564cf7b8b2fd17806eb0776f4255fbc855fa987a7cf1151462209e3b3aa4a` |
| `run11-final-runtime` | `42a915cc769e6ffd3406ce1b63cfdfa48e8f87ac61bb47ea58b21a51801d9ae0` | `529e8c04fd4ad5bed4e163be31e4f98ec8d91f1a085e2e211be341fc85f08ead` |

Für run10 und run11 sind unabhängig geprüft: eigene Schema-/OID- und Sitzungsabwesenheit, read-only Prüfverbindung ohne XID, eigenes DATA und ursprünglicher Prozess entfernt, Quelle unverändert, dieselben vier verwalteten Dienste gesund. Die beiden vom Controller als entfernt protokollierten Bundleverzeichnisse wurden zusätzlich tatsächlich als abwesend geprüft. Kein Container wurde gebaut oder neu gestartet.

Die folgenden endgültigen Dateien stimmen bytegleich mit dem Vorher-/Nachher-Census von `run11-final-runtime` überein:

| Datei | SHA-256 |
| --- | --- |
| `app/lib/collaboration/markdown-file-import-persistence.ts` | `878df20055f638efaf0c0e063f90616d9dbcdbf72635c26d79b46f59fc576c90` |
| `app/lib/files/markdown-create-birth.ts` | `5e1b1e5f14852b6eb5412411972fb0e5a60ffcd118473073393bf1e706702e8c` |
| `app/lib/pi/agent-file-operations.ts` | `ce0c6303ae03703dcec33b2743c97c867dd2457f40c6e8dc60e51219cd6a905d` |
| `app/lib/pi/agent-file-tool-results.ts` | `daf53102f1cc336520b5cd372194c5ceae9102be261d614f141ba022bd993ca1` |
| `app/lib/pi/core-tools.ts` | `fd38f77fe07c123a53effc83386f11f12b0333d0e60426f67b38863eb877daf8` |
| `app/lib/pi/tool-file-formatters.ts` | `8dc9067c5a4c482490f3c667b01a71f526b1eba1fee106cf757109916b33a190` |
| `app/lib/pi/tool-runtime-helpers.ts` | `a8557ecd4204063b6554db36f73be0e3ab17909e5ef09c9973a46341e4d80118` |
| `app/lib/public-sharing/tool-policy.ts` | `805c37798f95ec0b3f18df412a854817bfc09d5ece623f205e31adb85de30500` |
| `app/lib/settings-storage.ts` | `1246ef9ea94194e256054f47eb838de806b2813b7aef1dc294f430d5cbaa7693` |
| `app/lib/workspaces/request-principal.ts` | `19d0204c86992ef157b8e9f00ccd88139dd76b881c4b0e9c8736bb005c084352` |
| `scripts/runtime/markdown-create-birth.py` | `10ef10a1e94a89417f0d32ac13555d03d33212e324126da16bfd7557e65aefdd` |
| `scripts/run-document-read-tool-dispatch-test.mjs` | `9699d7d866d1003262fe00d14b0b979f853224ffae9b437d42f1150c162f3a3d` |
| `scripts/pi-markdown-create-postgres-entry.ts` | `079e4adc3ca86832f58487725250bc5f4d6393a063dbcea5ffa760b58d11357f` |
| `scripts/pi-markdown-create-postgres-test.ts` | `17586f19751ffcca3de7ab8aea7c095593b9f8774ea8e02bcfdd00882acebca2` |

## Verbleibende Launch-Gates

Dieser lokale Create-Teilschritt ist geschlossen. M2 insgesamt bleibt offen: Die vorhandenen Shell-/Skill-Schreibschutzprüfungen müssen verpflichtend auf echtem Linux in CI bestehen, anschließend darf die kontrollierte Aktivierung erfolgen. M3 benötigt einen frischen aktivierten Produktionsbuild, die gemeinsame UI-/API-/MCP-/Dateiaktionsabnahme einschließlich Copy, die Klärung der zwei erhaltenen roten Bestandsregressionen und vollständige PR-/CI-/Reviewfreigabe. SDK-Veröffentlichung, vollständige PDF-Konversion, breitere Suche und Standard-Skill bleiben nachgelagert. Der vollständige Konsolidierungsplan ist damit nicht abgeschlossen.
