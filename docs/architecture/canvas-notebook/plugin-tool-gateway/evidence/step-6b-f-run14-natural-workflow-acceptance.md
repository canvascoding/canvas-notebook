# Schritt 6b-f: gemeinsamer natürlicher Workflow — Run14, 2026-10-11

Status: **abgenommen**. Der frische vollständige Lauf mit lokalem Produktionsbuild endet mit ursprünglichem Whole-Launcher-Exit `0`: ein serieller Playwright-Fall, ein Worker, keine Retries und zwei tatsächliche Modellaufträge von zwei normalen Teamnutzern. Root hat die unabhängigen Belege und die reguläre Bereinigung geprüft. Der Lauf verwendet das echte Modell `ollama / kimi-k2.6:cloud`, Thinking `off`, mit zentraler Organisationskonfiguration; die MCP-/Composio-Anbieterantworten sind kontrollierte lokale Fixtures.

Privater Lauf: `/private/tmp/canvas-agent-settings-browser-OFEd9J`, Nonce `c2d8da7bfd9f61c6115baa9349fc8a13`. Öffentlich dokumentiert werden sichere Belege und synthetische UI-Daten. Externe Canva-Konten und Produktionsrollout gehören weiterhin zu Schritt 7.

## Tatsächlich geprüfter Ablauf

1. Normale Mitgliedschafts-/Aktivierungs- und Lizenzwege erstellen zwei gewöhnliche Nutzer und einen Team-Workspace. Der Administrator richtet einen gemeinsamen Team-MCP-Connector sowie einen getrennten Organisations-Composio-Connector mit ausdrücklich gewähltem Profil/Account und begrenzten Toolrechten ein. Die modellseitige Org-Konfiguration wird über den zentralen Konfigurations-/Secrets-Vertrag bereitgestellt und verifiziert; beide tatsächlichen Chats verwenden dieselbe ausgewählte Modellinstallation ohne persönlichen Fallback.
2. Der Administrator installiert ein vollständiges Plugin-/Skill-Paket und weist es ausdrücklich dem Team zu. Das UI veröffentlicht V1, bearbeitet danach Script, `SKILL.md` und Manifest und veröffentlicht V2. Der ältere Script-/Skill-Snapshot bleibt unverändert lesbar. Erst eine ausdrückliche zentrale UI-CAS-Änderung setzt die Workflow-Bindung auf die konkrete V2-Revision und Checksumme; die Veröffentlichung allein migriert keinen festen Pin.
3. Das UI ändert Beschreibung, verantwortliche Person und gezielte Nutzungsfreigabe. Beide Nutzer sehen den aktuellen Stand, dürfen den Workflow verwenden und erhalten keine Paketbearbeitung oder zentrale Konfigurationsverwaltung. Die spätere Ausführung verändert diese zentrale Konfiguration, Ressourcenrechte oder Verbindungsbindungen nicht.
4. Zwei verschiedene natürliche Rechercheaufträge laufen nacheinander mit demselben freigegebenen Agenten. Fachliche Schritte stehen in regulär konfigurierten `AGENTS.md` und dem veröffentlichten Skill; konkrete Tool-/Schema-Referenzen werden aus tatsächlichen Discovery-/Describe-Ergebnissen übernommen. Es gibt keinen Modellstub, keine injizierten Toolcalls und keine direkte Provider-Ausführung durch den Test.
5. Jeder Auftrag liest den vollständigen veröffentlichten V2-Skill genau einmal, inspiziert die exakte Paketressource und führt das freigegebene Node-Script genau einmal aus. Der Script-Bridge-Pfad erzeugt je einen MCP- und Composio-Leseaufruf. Beide Antworten nennen die bestätigten synthetischen Designs, V2 und die tatsächlich aktuelle verantwortliche Person. Native Canvas-E-Mail bleibt außerhalb dieses Designworkflows.

| Beleg | Nutzer 1 | Nutzer 2 |
| --- | --- | --- |
| Öffentliche Nachrichten im gespeicherten privaten Transcript | 20 | 17 |
| Toolfehler | 0 | 0 |
| Vollständige native V2-Skill-Reads | 1 | 1 |
| Script-Aufrufe | 1 | 1 |
| Erfolgreiche Provideraufrufe | 2 | 2 |
| Tatsächliche Paketversion | 2.0.0 | 2.0.0 |

Auftraggeber, Auth-Sessions, Chats und Scratch-Bereiche sind verschieden; der Agent, Workspace, feste Paket-Pin und die beiden gemeinsamen Verbindungsreferenzen sind gleich. Schema-Referenzen werden pro Nutzer aktuell beschrieben. Die Composio-Ausführung verwendet dieselbe zentrale Profil-/Account-Identität. Insgesamt sind genau vier erfolgreiche, exakt gebundene Provideraufrufe und vier passende erfolgreiche `integrations.call`-Auditzeilen belegt, zwei pro Quelle.

## Inhalt, Schema und Identität: genaue Beleggrenzen

Der öffentliche und persistierte Nachrichtenvertrag entfernt absolute Hostpfade: native Read-Argumente sind hier `{}`, private Pfadfelder fehlen. **Der vom Modell angefragte wörtliche private Dateipfad wurde nicht beobachtet.** Stattdessen prüft der Parent jeden tatsächlichen Read-Call/Result anhand seiner ID im gehashten, authentifiziert geladenen öffentlichen Transcript. Der vollständige Body, sein SHA und seine Länge stimmen mit der eindeutigen V2-Datei im aktuellen unveränderlichen Paketinventar und dessen eigenen Snapshotbytes überein und unterscheiden sich von V1. Beide V2-Bodies haben SHA `1214c856d9bab42a958ca78a96f6afbf41460f95545abca0d88c07018892b030`, Länge 3549 Bytes; V1 hat SHA `5dd34f556ae14519de6077b2e491600ee3e0b8af65c0e49dce70de07af673148`.

Die sichere Session-Modell-DTO stammt aus dem bereits authentifiziert gelesenen tatsächlichen Sessionkontext; ihr Artefakt-SHA entspricht dem jeweiligen `runtimeHash`. Der Parent gleicht Actor/Session/Agent/Workspace/Org/Installation/Modell/Thinking/Readiness mit dem Beleg ab. Er behauptet keinen nachträglichen unabhängigen Pi-Session-Reload nach der normalen Chatlöschung.

Auch erfolgreiche Call-Audits wiederholen keine `schemaRef`. Der Beleg korreliert die exakten tatsächlichen Audit-Tupel für Actor, Session, Agent, Workspace, Quelle, Provider, Tool und Toolcall mit der Script-Ausführung. Schema-Referenz und Eingabeschema sind durch die tatsächlich eingereichten `selectedBindings`, die gepaarten aktuellen Describe-Ergebnisse und den vor dem erfolgreichen Effekt schema-validierenden Dispatcher belegt. `schemaRefObservedInCallAudit` und `literalResolvedPathObserved` bleiben ausdrücklich `false`; die Produktverträge wurden für diesen Test nicht erweitert.

## Build, Source-Gates und reguläre Bereinigung

Produktfix `26047daae` stellt statische Legacy-Composio-Metadaten auch ohne System-Key bereit, damit eine tatsächlich konfigurierte zentrale Org-Verbindung normal einem Agenten zugewiesen werden kann. Regression `2b58b0d50` prüft den aktuellen Store-Provenienz-/Actor-Vertrag einschließlich einer ausdrücklich nutzereigenen Installation. Diese getrennten abgeschlossenen Änderungen gehören zur geprüften Produktbasis.

Der Root-Build3 hat Exit `0`. Run14 verwendet diesen erfolgreichen Produktionsbuild mit denselben fünf Produkt-/Launcher-/Fixture-/Config-Source-Hashes und derselben `BUILD_ID` `build-TfctsWXpff2fKS`; dazwischen erfolgten weder ein weiterer Build noch Produktänderungen. Nach Build3 änderten sich nur die drei Test-/Belegdateien `tests/agent-workflow-natural-model-local.spec.ts`, `tests/helpers/natural-workflow-model-setup.ts` und `scripts/helpers/natural-workflow-parent-proof.ts`. Root-Static16 bestätigt vollständigen TypeScript-Check und gezieltes ESLint auf den endgültigen Quellen. Der erhaltene Build-/Source-Beleg wird im Root-Proof über SHA `98833a32b48fb55cfe0395d3cfdec01fa789de29e69ae3eae55036650037ee5c` beziehungsweise `f2cd9769ecd27b5dca9021f348d7770101876c26f8bd1146b2c96d43633c2547` referenziert. Ein vollständiges byteversiegeltes `.next`-Inventar wurde nicht erhoben; der Build-ID allein kommt keine Aussage über unveränderte Artefakte zu.

Endgültige Testquellen:

| Datei | SHA256 |
| --- | --- |
| Natural-Workflow-Spec | `ef10043ee930a128b0852e4275768bc9fd60c95bdf2007f05054f15d9ed07d0e` |
| Modell-Setup-/Session-Helper | `00d5d9022996b7a594229fb4096d8494c79256b98a608af2d8780206baee92b2` |
| Unabhängiger Parent-Beleg | `3b5536028ed562afee42c6db6e9647d3eeb14594a7d1ceb2fbfe6d84bf4419d1` |

Die beiden eigenen Chats wurden normal gelöscht. Alle drei authentifizierten Browserkontexte meldeten sich regulär ab; normale Session-Reads ergaben jeweils `null`, alle Kontexte sind geschlossen. Notebook, Browser, Parent, Issuer und kontrollierter Provider schlossen regulär. Root bestätigt unabhängig die Abwesenheit der vier ursprünglichen PIDs, drei eigenen abgetrennten Kindgruppen, der drei Listener, beider Nonce-Datenbanken einschließlich DB-Sessions sowie DATA/TMP. Die gehashten privaten Logs, Receipts und Belegdateien bleiben erhalten. Der bestehende fremde Stack wurde nicht ersetzt.

Alle dreizehn vorherigen nicht abgenommenen Läufe bleiben separat mit ihren ursprünglichen Belegen und Hashes erhalten; `originalFailures` im Root-Proof listet sie vollständig. Teilweise erfolgreiche Modell-/Provideraufrufe daraus werden nicht mit Run14 kombiniert; die einzelnen ursprünglichen Ergebnisse bleiben maßgeblich.

## Belegdateien und Folgearbeit

| Datei | SHA256 |
| --- | --- |
| [Root-Proof](step-6b-f-run14-root-proof.json) | `e70a0b8386e79fa560718c610b943172ed61598cb5d83249e94295911c12406c` |
| [Audit-/Read-/Schema-Proof](step-6b-f-run14-audit-proof.json) | `d28885469b7f15ea05f06af42ff6d4f593a703ee403d0164123548c17b422f16` |
| [Admin-Freigaben](step-6b-f-run14-admin-resource-sharing.png) | `8154b81bfc8b4ce06372fdb152a491a6868640eddb1197cd73f3b0610951c93b` |
| [Ergebnis Nutzer 1](step-6b-f-run14-user-1-natural-result.png) | `ed1d321848e71600ba0829af0a9426c094a4b24c9a3065159613e1db9158be82` |
| [Ergebnis Nutzer 2](step-6b-f-run14-user-2-natural-result.png) | `99f201ad49c383105e73fd944cbb5f2fd94c2263166c0ef9c05c8bf3d666027e` |

Schritt 6b-f und damit 6b sind abgeschlossen. Schritt 7 und die Gesamtabnahme bleiben offen: fehlende echte externe MCP-Abnahme und abschließende externe Provider-Abnahme, kontrollierter Standardmoduswechsel mit Telemetrie-/Flag-Rückfallvergleich, finale Regression und Produktdokumentation. Der frühere [echte Composio-/Canva-Nachweis](live-composio-canva-2026-10-08.md) bleibt getrennt; Run14 ist keine externe Canva-Modellabnahme, kein physisches Mobile-Gerät und keine Produktions-/Releasefreigabe. Gateway weiterhin default-off; strikter Mobile-Audit unverändert RED23HIGH/0CRITICAL. Kein Containerbau, Push oder Deployment gehört zu dieser Abnahme.
