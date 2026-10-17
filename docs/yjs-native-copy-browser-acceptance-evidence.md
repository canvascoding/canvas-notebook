# Native Copy: erster gemeinsamer Browserlauf

Stand: 17. Oktober 2026. Der frische kompilierte Lauf ist beendet und bleibt **fehlgeschlagen**. Der Ressourcenabschluss ist separat bestätigt; die korrigierte Testspezifikation wurde noch nicht erneut im Browser ausgeführt.

## Gebauter und tatsächlich geprüfter Stand

| Bindung | Tatsächlicher Wert |
| --- | --- |
| Root | `9253e6ecac2f23ba3e78018d3eee2f506208e279` |
| QA | `8791513a819121f5afd0a791d761abebc745afdf` |
| Control Plane | `27c8ce37da082244f006ca376068cde6b98845d5` |
| Root-Sourcefingerprint | `31a67564b92e00665f4430da8287c65f0e4c6c9d8b993a35eef75f1081c430e7` |
| QA-Sourcefingerprint | `47234b1a116f52b2567bbeaf8e6d83af400955dba0574f9dff870414e691dc4c` |
| Buildfingerprint | `758061b5f817158304a1d1079538e1433651179ccb6bfaa359085941140d5b42` |
| Build-ID | `build-TfctsWXpff2fKS` |

Der originale Produktionsbuild endete mit Exit 0. Die unabhängige Prüfung bindet Source, Buildproof und tatsächliche Artefaktbytes einschließlich Native-C, Manifest und Addon. Die drei bewussten Root↔QA-Abweichungen bleiben auf denselben Aktivierungspatch und zwei historische Dokumente begrenzt; binärer Patch-SHA256 `b3c69c58e362e44bd5945415de80ec45537f5b67c41949020f78107cfc6997d4`. Allgemeine Aktivierung bleibt false; ausschließlich die QA-Abweichung aktiviert den geprüften Pfad.

Die privaten Originalberichte liegen unter `/private/tmp/canvas-copy-ui-independent-preparation-tyugefok/`: `source-report.json` SHA256 `753842f2dcbd7fdba4f163db1a10297462e8a8171a57757c42c56ac803fcd5d7`, `artifact-report.json` SHA256 `7a31cb3fab94a2a7cb264333827c4d31717c3567754640f2b21b2252505818c4`. Der Buildproof selbst hat SHA256 `61002ab3cbf29e8ba100c6e2dfb8e8c2687e08d2640bbb041d0e28bb39867680`.

## Originales Browserergebnis

Root führte genau einen Lauf aus: Session 95603, Fixture `canvas-yjs-authority-L7kDde`, tatsächlicher Exit 1. Geplant waren seriell NativeCopy 6, CopyOrigin 2 und Undo-OFF 2, zusammen zehn Fälle.

| Suite | Deklariert | Bestanden | Fehlgeschlagen | Nicht gestartet |
| --- | ---: | ---: | ---: | ---: |
| NativeCopy Desktop/Mobile | 6 | 2 | 4 | 0 |
| CopyOrigin | 0 | 0 | 0 | 2 |
| Undo-OFF | 0 | 0 | 0 | 2 |

Der Originalreporter zählt null Skips, null Testtimeouts und null Unterbrechungen. Zwei Fehler sind jedoch echte 15-Sekunden-Timeouts beim Warten auf eine HTTP-Antwort innerhalb des Tests; diese werden nicht zu bestandenen Fällen umgedeutet. Der unabhängige Postcheck endete deshalb ebenfalls mit Exit 1: `postruntime-report.json` SHA256 `24d0a99d3b621223ec00044d01c91aa2a38be8fb976d914b5f3c0007b1edebb2`.

Die beiden bestandenen Fälle prüfen Desktop und Mobile für manuell erzeugte Rich-Notiz, Markdown-Paste, echte V4-Vorschau und Planbindung, relative Linkanpassung, frische Cloneidentität sowie spätere ausschließlich am Clone sichtbare Bearbeitung.

## Belegte Fehler und enge Testkorrektur

Die beiden Mixedfolder-Fälle stoppten beim Anlegen einer enthaltenen Notiz. Die Fixture schrieb einen vollständigen Unterordnerpfad in das ausschließlich für den Dateinamen bestimmte Feld. Beide Originaltraces zeigen die UI-Meldung „Enter a valid name without slashes.“ und keinen zugehörigen Notiz-POST; die vorangegangene Ordneranlage lieferte HTTP 200. Das ist ein belegter Fixturefehler vor dem eigentlichen Mixed-Copy-Szenario, kein Nachweis eines fehlgeschlagenen Copy-POST.

Die beiden Pending-Recovery-Fälle erreichten vor ihrem Fehler die vollständige Operation, die bereits offene Zielansicht und die Prüfung des übernommenen gemeinsamen Titels. Der anschließende historische POST war mit HTTP 200 und `complete` erfolgreich; ausschließlich die folgende Assertion scheiterte am Vergleich der Reihenfolge in `completedSteps`: dieselben beiden Schritte standen in umgekehrter Reihenfolge. Der spätere vollständige History-Beobachtungsabschluss wurde dadurch nicht mehr ausgeführt.

Die Korrektur verändert genau zwei Testblöcke: echter Dateiname plus bestehender Ordnerpicker; historischer Operationsvergleich mit gleicher Anzahl, eindeutigen Schritten und sortiertem Mengenvergleich bei ansonsten identischem Ergebnis. Wartezeiten, HTTP-Prädikat, Produktdateien und die ursprünglichen vier Szenariokörper bleiben unverändert.

Original-Spec-SHA256: `da033d72462d4310cb263a2f92acb06d29c2a06e7d4302353514369d38b6e1ac`. Korrigierte Spec: `b6bffc307e200b3f24a08833f48cc2a5b309bdec241dc69fde1eeb47267c23fa`. Quellenkorrekturbeleg: `/private/tmp/cn-copy-ui-test-fixes-x6ow8gfe/report.json`, SHA256 `def7390d31ba3cdeea68cdd0130a477b088e6b200910360f38220aa36b902848`; ursprüngliche Traceanalyse SHA256 `16ad34c85821121faaf0ea9096cfe1aa680f352fd7450212000c3d0d357f49f9`.

Scoped ESLint, Diffprüfung und die vollständige cachefreie Typprüfung des korrigierten Quellenstands endeten mit Exit 0; Quellen blieben währenddessen gleich. Bericht `/private/tmp/cn-copy-ui-corrected-types-otkwr0og/results.json`, SHA256 `d32ee1c3390e80c2597f346ff70c8815d8e204513a85c00c5c5d831875599440`. Das ist kein erneuter Build- oder Browserpass. Ein getrennter quellenbasierter Hinweis zur ausstehenden Markdown-Projektion bei Pending-Recovery ist keine belegte Ursache dieser vier Browserfehler; daraus wurde keine Produktänderung abgeleitet.

## Separater Ressourcenabschluss

Nach dem negativen Postcheck führte Root ausschließlich die exakt gebundene eigene Bereinigung aus: Session 17209, tatsächlicher Exit 0. Beide ursprünglichen Datenbanken wurden nach erneuter Prüfung von Namen, OIDs, Ownern, Markern und null Verbindungen ohne FORCE entfernt. DATA und tmp wurden nach erneuter Realpath-/UID-/Mode-/Device-/Inodeprüfung relativ zu gehaltenen Verzeichnisdeskriptoren entfernt. Es gab keine Prozesssignale und keine Entfernung fremder Ressourcen.

Frisch bestätigt sind die Abwesenheit beider exakten Datenbanknamen/OIDs und ihrer Backends, DATA/tmp, aller beobachteten ursprünglichen Prozessidentitäten und Gruppen, der zugehörigen Ports und des Runlocks. Vier verwaltete Dienste bleiben identisch und gesund; drei Healthaufrufe liefern HTTP 200. Die Prozessbeobachtung ist keine vollständige Erfassung sämtlicher kurzlebiger Startprozesse.

Alle 96 geschützten Originaleinträge einschließlich Recoverybelegen, Logs, Reports und Traces bleiben unverändert. Der negative Originalstatus wurde nicht überschrieben. Cleanupbericht `/private/tmp/canvas-copy-ui-owned-cleanup-1sjln3m8/cleanup-report.json`, SHA256 `09ccf05c5a8bf23c06c41f236c91348bf141191d3a3e62dd6b5449c26efc797b`.

Nur die eigene uncommittete Testkorrektur wurde für die unveränderten Clean-Source-Guards vorübergehend auf die ursprünglichen Commitbytes gesetzt und anschließend exakt wiederhergestellt; Beleg `source-parking-report.json` SHA256 `28e54754d4204094f525983a54055805a0a22afe938083462deb8d560fbb29d9`. Das ändert weder den geprüften Buildstand noch die Originalberichte.

Offen bleiben neue QA-/Buildbindung der korrigierten Spec und die erneute vollständige Zehn-Fälle-Abnahme. Dieser Lauf beweist keine allgemeine Copy-UI-Abnahme, keinen neuen Undo-OFF-Pass, keinen vollständigen PDF-Import und keinen Gesamtabschluss von API, MCP, SDK oder Suche. Dateiaktions-Undo und Review Center bleiben ausgeschaltet; ein Produktionsrollout ist nicht freigegeben.
