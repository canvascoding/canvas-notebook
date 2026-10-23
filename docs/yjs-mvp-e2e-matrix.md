# Gemeinsame E2E-Matrix für den Dokumentkern

Stand: 23. Oktober 2026. **MVP-Abnahmestatus:94 Fälle in23 ganzen Specs bestanden.** Produktstand `7c24a631860787d668aea288b6573d7a48e3b6f0`. Die funktionale MVP-Abnahme ist im unveränderten Umfang mit 94 bestandenen Fällen in 23 ganzen Specs abgeschlossen: originale8e2-MCP10/1 und UI67/17 werden aufgrund belegter Produkt-/Orakelparität wiederverwendet (77/18); auf7c24 sind Rest-UI9/3 sowie Restart2/1 und REST6/1 neu bestanden (17/5). Dies ist die ausdrücklich erlaubte Komposition mehrerer echter Läufe, kein einzelner frischer Whole94-Lauf. Der ursprüngliche8e2-UI76-RED67/3/6 bleibt unverändert. Rest-UI9 endet mit Original4778/49c0a6 Exit0,9/9 und14/14 Abschlusschecks. Die gemeinsame remaining10-Runtime endet mit Original33018/94b3ac Exit0,10/10 und14/14 Abschlusschecks: Restart2 zuerst mit zwei echten Neustarts, danach REST6 und zuletzt Metadata2. Nur die acht Restart-/REST-Fälle zählen zu94; Metadata2 ist ein bestandener Zusatztest. PI12 ist separat12/12 bestanden und unabhängig geschlossen. Exakter Scopebeleg: `combined-94-23-7c24-actual-readonly-zpdwsdsy.json`, SHA `4faa14a6e7d7f693cee5098f7e2bf05c05e152074048bdc93b4748e323346ac3`. Originalbilder und SDK7/OFF18 bleiben an8e2 gebunden. Originalbelege im [MVP-Abnahmeindex](./yjs-mvp-tool-and-restore-acceptance.md), Reihenfolge im [Launchplan](./yjs-document-authority-mvp-launch-plan.md). FinaleDokumentations-CI, Reviews und Main-Abschluss sind über [PR #176](https://github.com/canvascoding/canvas-notebook/pull/176) noch frisch zu prüfen.

Die ursprünglichen 53 Fälle enthalten Shared-HTML11 sowie zwölf Clipboard-/UI-Regressionen. Diese zwölf sind keine nativen Datei-Copy-Tests. Der zusätzliche Pendingfall liegt zusammen mit vier anderen Fällen in einer ganzen Move-Spec; ihn allein zu zählen bildet keinen vorhandenen selektorfreien Gesamtlauf ab. NativeCopy, CopyOrigin, SceneCopy und DeleteLinks sind zusätzliche ganze Dateien. Die bestehenden Markdown-Insertion-/Gast-Defaults bleiben ebenfalls enthalten.

| Gruppe | Ganze Spec | Statische Fälle |
| --- | --- | ---: |
| manual17 | [editor-create-paste-import.spec.ts](../tests/editor-create-paste-import.spec.ts) | 15 |
| manual17 | [editor-manual-create-recovery.spec.ts](../tests/editor-manual-create-recovery.spec.ts) | 2 |
| additional23 | [shared-workspace-html-move.spec.ts](../tests/shared-workspace-html-move.spec.ts) | 11 |
| additional23 | [markdown-email-roundtrip.spec.ts](../tests/markdown-email-roundtrip.spec.ts) | 1 |
| additional23 | [markdown-properties-panel.spec.ts](../tests/markdown-properties-panel.spec.ts) | 1 |
| additional23 | [markdown-rich-blocks.spec.ts](../tests/markdown-rich-blocks.spec.ts) | 1 |
| additional23 | [code-block-copy.spec.ts](../tests/code-block-copy.spec.ts) | 2 |
| additional23 | [notebook-document-tab-actions.spec.ts](../tests/notebook-document-tab-actions.spec.ts) | 1 |
| additional23 | [notebook-query-loading.spec.ts](../tests/notebook-query-loading.spec.ts) | 4 |
| additional23 | [chat-document-link-labels.spec.ts](../tests/chat-document-link-labels.spec.ts) | 2 |
| mcp10 | [direct-mcp-native-create-import.spec.ts](../tests/direct-mcp-native-create-import.spec.ts) | 10 |
| restart2 | [editor-yjs-owned-restart.spec.ts](../tests/editor-yjs-owned-restart.spec.ts) | 2 |
| focus1 | [editor-focus-width.spec.ts](../tests/editor-focus-width.spec.ts) | 1 |
| native-move-after-viewer-and-cohort | [workspace-operation-native-move.spec.ts](../tests/workspace-operation-native-move.spec.ts) | 9 |
| native-copy6 | [workspace-operation-native-copy.spec.ts](../tests/workspace-operation-native-copy.spec.ts) | 6 |
| copy-origin2 | [workspace-operation-copy-origin.spec.ts](../tests/workspace-operation-copy-origin.spec.ts) | 2 |
| scene-copy4 | [workspace-operation-managed-scene-copy.spec.ts](../tests/workspace-operation-managed-scene-copy.spec.ts) | 4 |
| delete-links2 | [workspace-operation-native-delete-links.spec.ts](../tests/workspace-operation-native-delete-links.spec.ts) | 2 |
| retained-default6 | [editor-markdown-insertion.spec.ts](../tests/editor-markdown-insertion.spec.ts) | 3 |
| retained-default6 | [editor-guest-collaboration.spec.ts](../tests/editor-guest-collaboration.spec.ts) | 3 |
| agent-sandbox1 | [native-markdown-sandbox.spec.ts](../tests/native-markdown-sandbox.spec.ts) | 1 |
| recovery5 | [collaboration-recovery.spec.ts](../tests/collaboration-recovery.spec.ts) | 5 |
| **Bestandene Auswahl ohne REST** | **22 disjunkte Dateien** | **88** |

## Ausführung auf dem endgültigen Stand

Erst nach seriell abgeschlossenen Backendläufen und deren Ressourcenabschluss alle erforderlichen Produkt-/Testanschlüsse integrieren, aktuelles Main konfliktfrei einbeziehen und den frischen Originalbuild erstellen. Root/QA müssen denselben gebundenen Produktstand haben. Der vorhandene Builder ist:

```sh
node --conditions=react-server --import tsx scripts/run-yjs-authority-e2e.ts build
```

Die vorhandene Ausführung erfolgt anschließend mit `scripts/run-yjs-authority-e2e.ts run` und ausdrücklichen `--spec`-Argumenten für ganze Dateien aus der Tabelle. `--control-plane-head`, `--notebook-head` und `--source-fingerprint` müssen die tatsächlich geprüften Build-/Quellenwerte erhalten. Jede Runtime seriell abschließen und die eigene Ressourcenbereinigung unabhängig bestätigen, bevor die nächste beginnt. Keine zusätzlichen Container und kein zweiter Teststack.

- MCP10 muss nach dem vorhandenen Supervisor-Guard allein ausgewählt werden. Der enthaltene SDK-Fall benötigt eine echte frisch geprüfte Wheel-/Probe-Bindung; seine bisher gepinnte ältere Wheelfassung beweist keinen aktuellen SDK-Release und keine vollständige neue Copy/Move/Delete-Abnahme.
- Restart2 muss zwei echte Hostneustarts nachweisen.
- Der Runner ohne `--spec` führt nur fünf Editor-Defaults mit 24 Fällen aus. Das ersetzt die Tabelle nicht. Auch ein allgemeines `npm run test:e2e` verwendet einen anderen Einstieg und beweist diese versiegelte Auswahl nicht.
- Tatsächliche entdeckte und ausgeführte Zahlen am finalen Stand erfassen. Jeder deklarierte Fall muss bestehen; keine Fehler, Skips, Timeouts oder Unterbrechungen als Erfolg zählen. Die Konfiguration allein beweist das nicht.
- Die alte `workspace-operation-native-delete.spec.ts` verlangt Dateiaktions-Undo und gehört nicht zu dieser Undo-OFF-Auswahl. Die vorhandenen DeleteLinks-, SharedHTML- und Open-Viewer-Fälle prüfen den vorgesehenen zentralen Deletevertrag. Normales Text-Undo bleibt Bestandteil der Editorprüfung.

## REST-Abnahme in remaining10 und kombinierter Abschluss

[document-read-http.spec.ts](../tests/document-read-http.spec.ts) enthält sechs zusätzliche serielle Cookie-/Bearer-/ID-/UTF-8-Pagination-/Rechte-/Sign-out-Fälle. REST6 ist auf7c24 als mittlere ganze Spec der gemeinsamen remaining10-Runtime bestanden: nach Restart2 mit zwei echten Neustarts und vor Metadata2. Original33018/94b3ac Exit0 und der unveränderte gemeinsame14erAbschluss gelten für alle drei Specs; Metadata2 bleibt außerhalb94/23. Die sechs REST-Fälle ergänzen mit UI9 und Restart2 die77 quellgleich wiederverwendeten Originalfälle auf94/23. Ihre Reads beweisen keine vollständigen Create-/Edit-/SDK-Dateiaktionswege.

Die verbindlichen SDK-/API-/Agentenanschlüsse, progressive native Suche mit stabilen IDs und kontrolliertem Weiterlesen, Sandboxschutz sowie die vorhandenen Backend-/Recoveryverträge sind im dokumentierten MVP-Schnitt durch die vollständige erlaubte94/23-Komposition und separates PI12 belegt; ihre Originalbindungen stehen im [Abnahmeindex](./yjs-mvp-tool-and-restore-acceptance.md). Der vollständige PDF-Parserimport und der standardmäßig installierte Marketplace-Skill sind laut [Launchplan](yjs-document-authority-mvp-launch-plan.md) spätere Arbeiten und keine zusätzlichen MVP-Mergeblocker; diese Matrix belegt ihre Umsetzung nicht. Die 67 originalen UI- und zehn MCP-Erfolge werden nur mit belegter Quellparität wiederverwendet; sie werden nicht als neue Läufe umetikettiert. Review Center und Dateiaktions-Undo bleiben aus.

Die statische Quellenprüfung und unveränderten Originalkommandos unter `/private/tmp/canvas-mvp-concurrent-move-20261020-Y8J3GcFs/open-viewer-final-matrix-ro-o7o1l7r7/` (Freeze `0b620a2c85124803666c87d296977930063f31a74da63915393aeb35dc1e8fb4`) bleiben historische Vorbereitungsbelege mit eigener Quellenbindung. Sie ersetzen keine Funktionsprüfung; die aktuelle94/23-Komposition und separates PI12 sind durch ihre echten Originalabschlüsse im Abnahmeindex gebunden.
