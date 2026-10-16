# Native Delete-/Undo-Jobs: erster Anschluss und offene Browserabnahme

Stand: 16. Oktober 2026. Produktanschluss Root `7dccf9d2e7a05ca0d867731ce7c75b1de6a10e84`, QA `d790f95cbe20d3f94aaae5dd05ce93760f744217`. Die zusätzliche reine Testdiagnose liegt auf Root `38f0d2c0c6f355a4c1e2c46d719f081d65cdc171`, QA `f2aba57bbf40e2e2bac21e8b1edd23b35b28bccf`.

**Status:** Der echte Producer-/Store-/Worker-/Original-Delete-Anschluss besteht die unten getrennten PostgreSQL-Prüfungen. Die neue Browserabnahme ist noch offen: Beide ersten Fälle scheitern vor der Dateiaktion in einem zusätzlichen Beobachterprozess. Der nächste Lauf endet bereits vor dem Fixtureaufbau; eine Voraussetzung der gemeinsamen Testumgebung ist nachweislich nicht erfüllt. Der generische Laufabbruch benennt seine auslösende Assertion nicht. Allgemeine native Aktivierung bleibt aus.

## Enger Produktvertrag

Der Anschluss unterstützt genau einen nativen Delete, dessen vollständige Linkplanung keine Änderungen an anderen Dokumenten verlangt. Native Move-/Copy-Aufträge, Mehrfachauswahl, tatsächliche fremde Linkmutationen und unbekannte physische Markdownquellen werden weiterhin abgewiesen. Ein solcher abgewiesener Fall gilt nicht als erfolgreiche Linkpflege.

Der reguläre [Producer](../app/lib/files/workspace-operation-batch-plan.ts) erhebt zunächst den vollständigen Quellenstand. Der neue [V2-Plan](../app/lib/files/workspace-operation-native-delete-plan.ts) bindet native Zielidentität, Quellbelege und tatsächlichen nativen Graph. Er benötigt keinen verlustfreien Markdownexport des nativen Ziels und enthält keinen erfundenen V1-Markdownplan. Der Store prüft den gespeicherten Plan strikt, bevor eine echte Jobübernahme Autorität erzeugt. Öffentlich erscheinen nur begrenzte Vorschaufelder. Die bisherige V1-Planform bleibt für tatsächlich uninitialisierte physische Quellen bestehen; ein entkleideter V2-Datensatz kann nicht als V1 übernommen werden.

Die [Quellenerhebung](../app/lib/markdown/workspace-source-authority-stage.ts) kann auf der echten bereits gehaltenen Ownerverbindung B lesen. Zwei vollständige Beobachtungen und Katalog-/Dateiprüfungen binden denselben Arbeitsbereich; Schema und Linkinventar stammen aus denselben dekodierten nativen Daten. Metadata- und Gesamtgrößenprüfungen erfolgen vor BLOB-Reads. Mehrdeutige, fehlende, gewachsene oder nicht vollständig beobachtete Zustände verwerfen die Beobachtung.

Der [Job-Owner](../app/lib/files/workspace-operation-job-lifecycle-owner.ts) hält für diesen Arm den exklusiven workspaceweiten Lifecycle-Guard. Tatsächliche Raumreservierungen, Ownerzeilen, Verbindungen und Advisory-Locks müssen vor Beginn frei sein. Ein geöffneter fremder Raum wird hier noch nicht automatisch entwöhnt. Der [Originalkern](../app/lib/files/workspace-operation-original-delete.ts) prüft aktuelle Quellen und Graph vor Intent, vor dem FS-Schritt und erneut vor dem nativen Archivieren in B2. Die ursprünglich ausgewählte physische Projektion bleibt, falls vorhanden, an ihren exakten Dateibeleg gebunden.

Undo verwendet die ursprünglichen D1-/L1-/Trashbelege, aktuelle menschliche Rechte und den ursprünglichen Inhalt. Aus Generation G wird G+2; Dokument-ID, ursprüngliche Sequenz, State-Proof und Vector bleiben erhalten. Vor der Wiederherstellung werden aktuelle Quellen und die hypothetische Originalrückkehr geprüft; nach dem tatsächlichen nativen Restore-CAS wird der wirkliche neue Graph auf derselben B-Verbindung geprüft. Neue D2-/S2-Ziele werden nicht übernommen, alte Publicfreigaben nicht wiederbelebt. Eine nach bereits erfolgtem FS-Restore unterbrochene SQL-Phase kann nur über den exakten privaten FS-Beleg wiederaufnehmen.

Status und öffentliche Resultate beruhen auf den tatsächlichen Originalintents/-Completions und Trash-/Native-/Publicbelegen. Undo-Verfügbarkeit ist eine aktuelle beratende Prüfung; der Mutationskern wiederholt seine verbindlichen Gates. Unbestätigtes Rollback oder Disposal bleibt ein eigener 503-Ausgang und wird nicht zu einer gewöhnlichen Nichtverfügbarkeit umgedeutet.

## Tatsächliche Prüfungen

Alle folgenden PostgreSQL-Läufe wurden seriell auf PG18 ausgeführt. Sie bestätigen den Abschluss ihrer eigenen Assertions und Ressourcenbereinigung; die Authority-Regressionen sind keine zusätzlichen Dateiaktionsfälle.

| Gruppe | Bestandene Familien |
| --- | ---: |
| Native Producer/Claim/Delete/Undo, Plain/XML/Blocks einschließlich nicht exportierbarem Rich mit und ohne Projektion | 5 |
| Tatsächlicher unersetzter Worker, pristine V1 und verlorener Completion-ACK | 3 |
| Frische Quellenänderung, ausgetauschte Zielprojektion, fremder tatsächlicher Roomowner, FS-/SQL-Unterbrechung, neuer eingehender Link vor Undo | 5 |
| Ursprünglicher Delete / Restore / Restore-Recovery / A-B-Scheduling | 20 / 10 / 5 / 1 |
| Job-Owner mit heutigen Rechten | 30 |
| Gemeinsamer Member-/Agent-/Guest-Principal | 66 / 49 / 30 |

Zusammen sind das 224 tatsächliche PG-Prüffamilien mit ihren jeweiligen Grenzen. Die sieben Dateiaktionsgruppen melden `schemaRemoved:true`, `dataRemoved:true`, `openClients:0`, `openCheckouts:0`; die Owner-/Principalfolgen schließen ebenfalls ihre eigenen Ressourcen. Vollständiges cachefreies TypeScript und Scoped-ESLint bestehen auf dem Produktstand und erneut nach der reinen Testdiagnose. Ergänzende reine/PGlite-/FS-Prüfungen decken Quellenbelege, Resolver, V2-Dekodierung, Undo-Graph, Originalbeobachter und die unveränderten V1-Verträge ab.

Die erste native Folge erreichte reale SQL-Abbrüche `25P04`; nach einer ersten Bündelung bestand erst einer von fünf Fällen. Quellenheader/BLOBs, tatsächliche Original-State-Locks, Storageinspektion und frische Principalheader sind inzwischen gebündelt. Die vollständigen ursprünglichen Row-, Realm-, Schema-, Funktions-, Rechte-, Claim- und Clockprüfungen bleiben erhalten; weder Cache noch längere Transaktionsgrenze wurden eingeführt. Die finale native Fünferfolge besteht unter derselben Grenze. Daraus folgt keine allgemeine Maximalgrößen- oder Lastgarantie.

Weitere zwischenzeitliche Workerläufe lieferten `needs_recovery` beziehungsweise einen nicht bestätigten Undo-Ausgang, ohne den ursprünglichen verschachtelten Fehler zu erfassen. Ein transparent diagnostizierter Lauf und danach die finale unersetzte Dreierfolge bestehen. Die früheren Ursachen sind dadurch nicht rückwirkend bewiesen. Ein gesonderter Owner-Testfehler entstand durch den zu frühen statischen Authimport des neuen Legacy-Plan-Fixturehelpers; der tatsächliche Builder wird dort nun erst bei Verwendung geladen. Danach besteht dieselbe Ownerfolge mit 30 Familien. Die alten Fehlprotokolle bleiben erhalten.

## Builds und erster Browserbefund

Beide Produktionsbuilds des unveränderten Originalsupervisors bestehen; unabhängige Vor-/Nachprüfungen bestätigen Quellen, gebaute Artefakte, die zehn ursprünglichen QA-/Buildhelfer und beide ursprünglichen Roomreader. Root und QA besitzen weiterhin ausschließlich drei bekannte Unterschiede: Aktivierungsgate und zwei historische Dokumenttexte.

| QA-Commit | Quellenfingerprint | Buildfingerprint |
| --- | --- | --- |
| `d790f95cbe20d3f94aaae5dd05ce93760f744217` | `4480f7aa8c00852d5fc38b7a9094a4b7153b56961a15776aeca00b5df0c60052` | `3205ce4a169f92a427c1cdae6bac1a7682ad88dcc301f55a1706a67da34db4a5` |
| `f2aba57bbf40e2e2bac21e8b1edd23b35b28bccf` | `540ec2eb094ad50ea4a2f95174028f6372ece1a23113ec635af5f25e0808c0aa` | `ce7ec1d9e9b05ad670b45d83c95ce0f32767fef7ab6fb9db3aad50e85caede49` |

Die neue [Browserfolge](../tests/workspace-operation-native-delete.spec.ts) soll für Desktop und Mobilgerät echte native Eingabe, normale Raumfreigabe, Filebrowser-Delete, unmittelbares Toast-Undo sowie ursprüngliche Identität und exakten Inhalt im frischen Browserkontext prüfen. Im ersten Lauf meldet der Originalreport **0/2 bestanden**, zwei Fehler, keine Skips oder Testtimeouts. Beide Traces zeigen den dauerhaft bestätigten Eingabestand und scheitern danach beim allerersten SQL-Raumbeobachter nach etwa 30 Sekunden. `Close preview`, Delete und Undo sind noch nicht erreicht. Der Kindprozess wird nach dem Timeout nachweislich beendet. Die danach ausgewählte bestehende physische Datei-/Linkregression startet nicht.

Ein separat gemessenes originales `assertBuildProof()` besteht in 10,019 Sekunden; die drei späten Serverimports beenden sich in einem isolierten Dummy-Port-9-Versuch natürlich nach 1,09 Sekunden ohne TCP-/Timerrest. Diese Einzelmessungen reproduzieren den ursprünglichen Timeout nicht. Die neue [Phasenaufzeichnung](../scripts/owned-yjs-native-file-room-read.ts) erhält den vollständigen Originalguard, denselben tatsächlichen READ-ONLY-Raumread, Clientabschluss, die 30-Sekunden-Grenze und sämtliche fachlichen Assertions. Sie schreibt nur feste Phasennamen, monotone Zeiten und Ressourcentypen in eine private eigene Datei. Ein bestandener Browserlauf oder eine bewiesene Timeoutursache folgt daraus noch nicht.

Die fehlgeschlagene erste Fixture ist nach eigener Namens-/OID-/Owner-/Markerprüfung separat bereinigt: beide eigenen Datenbanken fehlen, eigene Clients, Prozesse/Gruppen und drei Ports sind geschlossen, DATA/tmp entfernt und Runlock frei. Die Originalreceipts bleiben unverändert mit `phase:preserved`, `passed:false` und `uncertain:true` erhalten; `manual-cleanup.json` dokumentiert die nachgelagerte Bereinigung. Rohtraces, Runtime-ENV und Zertifikate bleiben privat.

Der nächste originale Runtime-Aufruf endet bereits vor dem Fixtureaufbau. Aktuell laufen die drei verwalteten PG-/Control-Plane-Container, während `canvas-local-prod-notebook` seit `2026-10-16T10:27:03.971238389Z` gestoppt ist. Der Originalsupervisor verlangt auch diesen laufenden verwalteten Container. Es wurde dafür kein alter Container eigenmächtig gestartet, kein neuer gebaut und kein Guard entfernt. Die Klärung der gemeinsamen Umgebung und der tatsächliche Folgelauf stehen aus.

Private Quellenbelege: `/tmp/canvas-native-integration-source-freeze-validated.json` (55 Dateien, SHA256 `886c7a5eac74c04394d16b88a54cc11f16449de5cbbc274ae1bda4451fa60b72`) und `/tmp/canvas-native-observation-source-freeze.json` (56 Dateien, SHA256 `d6884f508dab5a9eabcd1b53081f31df6a5c6b243650c90585ec9539c60c864e`). Unabhängige Vor-/Nach- und Originalreportbelege liegen im privaten Verzeichnis `canvas-native-source-build-audit-S1JuZD`. Das ersetzt keinen noch fehlenden Browserabschluss.

## Nächste Anschlüsse

Zuerst ist dieses Browsergate mit tatsächlichen Room-/Releasebelegen abzuschließen. Anschließend folgt ein einzelner Delete mit echten eingehenden nativen `unlink`-Effekten unter demselben Original-Job-Owner: originale Quellpins, vorbereitete Deltas und gezielte Inversen vor FS dauerhaft binden; Quellen-CAS, Archivierung und Abschluss gemeinsam in B2 bestätigen; Status und Undo an dieselbe vollständige Effektmenge anschließen. Bestehende selbst transaktionierende Writer oder ein anders autorisierter DA04-Handoff dürfen dafür nicht verschachtelt oder mit erfundener Autorität aufgerufen werden.

Move, Copy, vollständige zentrale Linkpflege, öffentlicher API-/Python-SDK-Vertrag, Standard-Skill-Auslieferung und tatsächlicher PDF-Import bleiben offene Pakete des [Anschlussplans](./central-notebook-file-api-import-plan.md). Der [vorbereitete Marketplace-Skill](./yjs-documents-skill-preparation.md) beschreibt bedarfsgerechte Anleitung und frischen Dokumentkontext, ist aber noch keine Standardauslieferung oder SDK-Abnahme. Review Center bleibt ausgeschaltet und außerhalb dieses Auftrags. Es wurde nichts gepusht, veröffentlicht oder in Produktion verändert.
