# MCP-Dateiaktionen: unveränderliche Copy-Herkunft

Stand: 18. Oktober 2026. Dieser Schritt ist die Daten- und Abgrenzungsgrundlage des noch offenen öffentlichen Dateiaktionsanschlusses. Er stellt noch keinen ausführbaren MCP-Copy-Principal, kein registriertes Dateiaktionstool und keine neuen SDK-Dateiaktionsmethoden bereit.

## Umsetzung

Der [Copy-Origin-Vertrag](../app/lib/files/workspace-operation-copy-origin.ts) behält das bestehende V1-Format für Web-/PI-Aufträge. Der neue V2-Vertrag bindet ausdrücklich `transport: direct-mcp`, den vollständigen OAuth-Client, Benutzer, kanonischen Agenten-Actor, ursprüngliche Sitzung und beide unveränderlichen Workspace-Scopes. Er enthält weder Bearer noch Claims oder einen ausführbaren Principal. Auch der neue Capturer erzeugt ausschließlich unveränderliche Daten und erteilt keine Rechte.

Der Vergleich einer ursprünglichen Sitzung A mit einer aktuellen Sitzung B erhält A unverändert. Benutzer, Client, Transportversion und beide Scopes müssen weiter übereinstimmen. Ein V1-/V2-Wechsel bleibt auch bei identischen Actorwerten ausgeschlossen. Der gemeinsame Decoder und der neue MCP-Capturer weisen ungültige Unicodewerte, zusätzliche oder versteckte Felder, Getter und Proxies ohne Ausführung ihrer Traps zurück. Die V1-Feldreihenfolge bleibt bytegleich.

Die bestehenden [Web-/PI-Copy-Principals](../app/lib/workspaces/copy-principal.ts) und der [Copy-Owner](../app/lib/files/workspace-operation-native-copy-owner.ts) lehnen V2 ausdrücklich vor ihrer bisherigen Autoritätsauswahl ab. Ein MCP-Actor darf dadurch nicht versehentlich als PI-Agent behandelt werden. Der spätere positive MCP-Anschluss benötigt seinen eigenen tatsächlichen Principal und dieselben bestehenden Copy-/Link-/Recoverydienste.

## Tatsächliche Prüfungen

| Prüfung | Ergebnis |
| --- | --- |
| Origin-Vertrag einschließlich V1-Bytes, A/B, fremdem Client und manipulierten Eingaben | 28/28, ursprünglicher Exit 0, keine Skips/Cancel |
| Echtes PostgreSQL-18-Journal | 9/9, ursprünglicher Exit 0; Originalrequest und `xmin` nach Retry und Ablehnungen gleich |
| Genuine Web-/PI-Principalfolge | 17/17, ursprünglicher Exit 0; neue negative MCP-Datengrenze vor SQL und Callback, kein OAuthnachweis |
| Owner-Vorlauf | ursprünglicher Exit 1; alle 25 Bestandsgruppen bestanden, neue Gruppe stoppt in zusätzlicher Setup-Vorbedingung vor ihrer eigentlichen Abgrenzung |
| Korrigierte vollständige Ownerfolge | 26/26, ursprünglicher Exit 0; alle 25 Bestandsgruppen und tatsächliche neue MCP-Abgrenzung bestanden |
| Gezielte TypeScript-Prüfung mit vorhandenen Ambientdeklarationen | Exit 0; kein vollständiger Repository-Typecheck behauptet |
| Scoped ESLint aller acht geänderten Code-/Testdateien | Exit 0 |

Der erste gezielte Typecheck ließ im eigenen Prüfconfig die vorhandene Deklaration `types/turndown-plugin-gfm.d.ts` aus und meldete genau diesen fehlenden Typ. Der korrigierte Config nimmt die vorhandenen Deklarationen auf; Produktdeklarationen oder Compilerregeln werden nicht abgeschwächt.

Der Owner-Vorlauf erwartet im zusätzlichen Setup `NATIVE_COPY_COMMIT_UNCONFIRMED`, erhält jedoch `NATIVE_COPY_PUBLICATION_UNCONFIRMED`. Der Fault-/Abgrenzungsbeweis war noch nicht erreicht; aus diesem Ergebnis wird keine gesicherte Produktursache abgeleitet. Originalquelle, Log und Exit-1-Bericht bleiben erhalten. Die korrigierte neue Gruppe verwendet stattdessen den bereits von der unveränderten 25. Gruppe tatsächlich erzeugten offenen V1-Web-Auftrag. Begrenzte Headerauswahl, vollständiger kanonischer Requesthash, Stage4, Plan, Originalactor, beide Scopes und tatsächlich committed C3 werden gebunden. Ein neuer Operationsname mit denselben ursprünglichen Eingaben dient ausschließlich der Einstiegskontrolle und behauptet keine heutige Previewreadiness. Preview, frischer Einstieg und Recovery müssen vor Pool-Checkout und Produkt-SQL scheitern; alle eigenen Tabellenzeilen einschließlich `xmin` sowie Dateiinhalt, Identität und Stagepfade bleiben gleich. Dies ist kein positiver MCP-Recoverybeleg.

Die privaten Originale liegen unter `/private/tmp/canvas-copy-mcp-origin-h78lwsko/`; der erste Ownerlauf unter `owner-v1/`, der korrigierte unter `owner-v2/`. Die ursprüngliche fehlgeschlagene Testquelle hat SHA-256 `3e616682ff232be634208825aff7498044b7bebba4384a5dc4a3bbf586920849`, die korrigierte `7742890b2e631e5683448e1c3bc33e51993fdc3120a269bbaa5498487f51e23e`. Der erste Ownerlog besitzt SHA-256 `ef6d90e1a512348abc5d44183ec929464ee32653f8f9cc419c16ebed7d5320fb`, der abschließende SHA-256 `cd03b2b2384d688d080ff12d5d06ffd642bc60309b22dc36f71220e5876f8045`. Der originale zweite Runner (PID 2656) endet nach rund 663 Sekunden mit Exit 0. Alle 26 Gruppen einschließlich der drei tatsächlichen negativen Einstiegspfade bestehen; es gibt keinen ausgeführten positiven MCP-Auftrag in dieser Folge.

Die frische eigene RR-/READ-ONLY-Prüfung des Vorlaufs bestätigt alle drei exakten Schema-/OID-Paare und zugehörigen Backendpräfixe als abwesend. Bekannte ursprüngliche Runner-/Child-PIDs und eigene DATA sind abwesend. Die vier verwalteten Dienste behalten ihre ursprünglichen IDs und gesunden Zustand; drei Health-URLs liefern HTTP 200. Das ist eine begrenzte tatsächliche Abschlussbeobachtung, keine Vollhistorie unbeobachteter Prozesse. Es wurden keine Container erstellt oder verändert. Die getrennte abschließende Prüfung `postcheck.json` besteht ebenfalls mit Exit 0 und bestätigt diese Grenzen erneut für den tatsächlichen erfolgreichen zweiten Lauf. Beide Prüfungen bleiben getrennte Originale.

## Verbleibender Anschluss

Der nächste Schritt verbindet eine eigene feste MCP-Copy-Autorität mit der bestehenden Ownerkette. Ein unveränderlicher verifizierter Token-/Claims-Satz muss Quell-Leserecht und Ziel-Schreibrecht auf derselben echten B-Verbindung prüfen; die aktuelle Sitzung bleibt vom Original getrennt. Öffentliche Preview-/Apply-/Status-/Recoveryverträge und SDK-Methoden kommen erst mit diesem echten Anschluss hinzu. Reiner Status darf keine Stagebereinigung oder erneute Ausführung auslösen.

Move/Delete benötigen außerdem einen eigenen aktuellen MCP-Workerpfad; jeder Agentenauftrag wird dort bisher als PI behandelt. Gespeicherte Identitätsdaten sind keine autonome Delegation. Ein Auftrag ohne frischen tatsächlichen MCP-Principal darf nicht als Benutzer oder PI-Agent weiterlaufen. Review Center und Dateiaktions-Undo bleiben aus. Die bisherigen SDK-Browserbelege gehören weiterhin ihren damaligen Quell-/Buildständen und werden nicht diesem neuen Zwischenstand zugerechnet.

## Bindung der Originalprotokolle

| Original | SHA-256 |
| --- | --- |
| `unit-final-v1.log` | `79323d92965bba13fbb8be6823246ddb633ccf0ba5886d6378fda977f2a1f3e4` |
| `workspace-operation-copy-origin-postgres-test.log` | `70eb4ffdf3fd1df4839660df428b626e9262bdb9f26d57f64b3f5044908a33ba` |
| `workspace-copy-principal-postgres-test.log` | `b40844bba9309a4fb90b34ca932722a129f723d47fdfe55b7c3b3fefe9d424a2` |
| `owner-v1/workspace-operation-native-copy-owner-postgres-test.json` | `2f45e1179c873ff00d96a057c3856efbd255103875d95eda7ecbe6b66b311dc1` |
| `owner-v2/workspace-operation-native-copy-owner-postgres-test.json` | `f32cae712b208072137873970224b06b453768ba94dd95d3f6387ce55e59e446` |
| `failed-v1-postcheck.json` | `e26b7d6983499733b5935efbfe8bbe141f69884305900ba137ef6651e10190f2` |
| `postcheck.json` | `7e359ebc5e9705e32b08d74a7d6a2a9fe7836d466f12e8b0c3c243276b9ab8d0` |

Die gezielte Typ- und Lintprüfung wurde vor dem abschließenden Ownerlauf auf exakt dessen Code-/Testfassung ausgeführt. Danach änderten sich nur die Beleg- und Plantexte. Der historische Konsolidierungsanhang bleibt bytegleich. Es gibt hier keinen neuen Produktionsbuild oder Browsernachweis; die vollständige gemeinsame E2E-Abnahme erfolgt nach dem noch offenen öffentlichen MCP-/SDK-Anschluss.
