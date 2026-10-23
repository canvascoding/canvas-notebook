# Expliziter Import bestehender Markdown-Dateien: API-Teilschnitt

Stand: 19. Oktober 2026. Ausgangscommits Root `0d84c4b385278682283faf5b42ffd9a83b58abe5` / QA `6e3791927ee04d7d1f57889853c728e32f692c34`. Dieser additive Schnitt wird durch die unten gebundenen Produkt-/Testbytes beschrieben. Er schließt den expliziten Import einer vorhandenen, beschreibbaren Originaldatei in den bestehenden nativen Kern. **M1 und der MVP bleiben offen.**

## Verhalten und Grenzen

`POST /api/documents/import-existing` übernimmt ausschließlich Workspace/Pfad, Operations-ID, beobachtete Dateiversion und optionale Anfangsrepräsentation. Ein echter aktueller Cookie-/Bearer-Schreibprincipal, gehaltene Lifecycle-Ownership und der vorhandene Original-FD-/Parser-/Importkern prüfen die Quelle. Registry, Lineage, Yjs-Zustand, ursprünglicher Importbeleg und zusätzlicher unveränderlicher Requestbeleg entstehen in derselben tatsächlichen SQL-Transaktion B. Originalbytes und Dateiversion bleiben unverändert. Abwesende Registrierungen erhalten neue echte IDs; eine nachgewiesen pristine Registrierung behält ihre ID. Ein bereits initialisierter Gewinner wird nicht neu importiert.

Wiederholung und `POST /api/documents/import-existing/status` lesen unter erneut geprüften aktuellen Schreibrechten zuerst den ursprünglichen Beleg. Eine echte neue Sitzung desselben Benutzers kann denselben Vorgang bestätigen; die ursprüngliche Autor-/Sitzungszuordnung bleibt erhalten. Fehlender heutiger Pfad oder eine andere spätere physische D2-Datei werden nicht als ursprüngliche Quelle übernommen. Status und bestätigte Wiederholung migrieren, checkpointen oder schreiben keine Dokumente. Die vorhandene Principal-Implementierung bleibt unverändert; ihr RC/RW-Transaktionsvertrag wird nicht für einen Statusreader abgeschwächt.

Die öffentliche Antwort enthält ausschließlich ursprüngliche Importfakten: Dokument-ID/Lineage am Importzeitpunkt, Repräsentation, Generation, Anfangssequenz/-proof, Zeitpunkt und Originalhash/-bytes. Sie behauptet weder heutige Location noch aktuelle Projektion. `requiresFreshFileActionPreview: true` fordert nachfolgende neue Vorschau. Der ursprüngliche Importbeleg V1 und bisherige Bootstrap-/Createverträge werden nicht umgedeutet.

Beide exakten API-Pfade besitzen wie die bestehenden nativen Read/Edit-Endpunkte ihre eigene tatsächliche Authentifizierung und begrenzte Streamleser. Der tatsächliche Next-Proxy-Matcher nimmt ausschließlich diese Pfade aus vorgelagerter Bodypufferung heraus. Die Handler begrenzen den Auswahlbody vor UTF-8-/JSON-Dekodierung auf 32 KiB, verwenden die bestehenden Limits 60/120 und sichere Fehlercodes ohne interne Payloads.

Kein UI-Importdialog, kein tatsächlicher Netzwerk-/Browserlauf und kein MCP-Importtool werden mit diesem Handlernachweis behauptet. Eine READ-only-Raw-Copy muss die Originalquelle unverändert lassen und braucht weiterhin den Zielimport. Automatisches, zur jeweiligen Dateiaktion gehörendes Raw-Link-Rebinding, die erhaltene Produktionsgegenprobe, interne Agenten-Neuanlage, Linux-Schreibschutz/CI, Produktionsaktivierung und gemeinsame finale Build-/UI-/E2E-/PR-Abnahme bleiben offen. Der Root-Aktivierungsschalter bleibt `false`; Dateiaktions-Undo und Review Center bleiben aus.

## Tatsächliche Prüfung

Der abschließende eingefrorene Lauf `validation7` endet für alle fünf Programme mit ursprünglichem Exit 0: gezieltes cachefreies TypeScript, Scoped-ESLint, sieben echte Service-/PG18-/FD-Gruppen, sieben echte POST-Handler-/PG18-Gruppen und der tatsächliche Next-Matcher-/Body-/Limit-Grenztest. Alle 13 Produkt-/Testquellen bleiben während des Laufes unverändert.

Die Servicefolge prüft echte aktuelle Sitzungen/Rechte, ursprüngliche BOM-/CRLF- und LF-/Unicodebytes, denselben tatsächlichen B-Backend/XID für alle fünf Inserts, vollständiges ID-/versionsgebundenes Weiterlesen, pristine Identität, unveränderte Wiederholung/Status, neue SID-B mit ursprünglicher SID-A, fehlenden heutigen Pfad und ungültige spätere D2-Bytes, stale FileVersion, echten Schreibrechtsentzug sowie wirklichen COMMIT-Bestätigungsverlust nach unabhängig sichtbaren unveränderlichen Zeilen. Ein widerrufener ursprünglicher Request kann den Erfolg nicht bestätigen; ausdrücklich erneuerte Sitzung bestätigt anschließend denselben ursprünglichen Vorgang ohne Replay.

Die Handlerfolge ruft echte Produktions-POST-Exporte mit echten Cookie-/Bearer-Sitzungen auf. Sie prüft zwei Originalprofile, ausschließlich erlaubte Antwortfelder, tatsächlichen vollständigen Read über die zurückgegebene ID, bestätigte Wiederholung und bekannten/unbekannten Status, ungültiges JSON/Schema/UTF-8, frühes Stream-Cancel ohne späteren Pull über 32 KiB, reale 401-/403-Ablehnungen und den ursprünglichen 429-Limiter. NoWrite-Fenster vergleichen Domainzeilen samt `xmin`, Tabellen-/OID-Inventar und vollständigen eigenen DATA-Baum samt Identitäten und Hashes. Fixtureanlage, Credentials und administrative Gegenproben liegen außerhalb dieser Fenster.

Die bestehende Importregression `validation6` besteht auf denselben 13 Quellen unverändert: 29 Originalbootstrapgruppen, 14 Writebootstrapgruppen, zwölf Anfangsformatgruppen, die vollständige bisherige allgemeine PG-Importmatrix und acht reine Compilerfälle. Der ausschließlich für import-only PI-Pakete begrenzte private Node-Resolver lädt deren tatsächliche Implementierung; er ersetzt keine Authority, Ergebnisse oder Produktquelle. Keine globale Importbedingung wird auf `pg` angewendet.

Die unabhängigen Ressourcenabschlüsse bestätigen nach beiden neuen PG-Folgen entfernte eigene Schema-Namen/OIDs, geschlossene eigene Sessions/Clients, entfernten DATA-Baum, beendete Originalprozesse und dieselben vier gesunden verwalteten Dienste. Der separate READ-ONLY-Regressionsnachcheck findet keine eigenen Schema-/Backend-/DATA-Präfixe und keine Diagnoseschemata; er erhält keine XID. Kein Container wurde gebaut oder neu gestartet.

## Erhaltene Fehlversuche und Korrekturen

- `validation1`: tatsächliche PG-Migration scheitert mit SQL 42601. Eine reale eng isolierte DDL-Diagnose reproduziert das innere `CASE ... THEN` im PL/pgSQL-IF. Klammerung der CASE-Expression korrigiert den Parser; dieselbe echte DDL-Probe besteht mit Rollback und entferntem Diagnoseschema.
- `validation2` / `validation3`: erste sechs Servicegruppen bestehen, siebte scheitert im Sitzungstesthelfer. Der echte Better-Auth-Reader kann die bereits abgelaufene SID-A entfernen; der bisherige Helfer verlangte danach nochmals ein erfolgreiches UPDATE derselben Zeile. Der normale Rotate behält exakt `rowCount === 1`. Nur der ausdrücklich bereits widerrufene Fall verlangt Abwesenheit oder dieselbe Member-SID mit exakt `expires_at = 1`, bestätigt fehlenden aktuellen Grant, erzeugt echte SID-B und verlangt weiterhin die Ablehnung des Altrequests. Kein Produktbypass und keine allgemeine Zählwertlockerung.
- `validation4`: der noch ungestartete HTTP-Test scheitert an einem NextRequest-Init-Typunterschied. Ein enger tatsächlicher Konstruktorparametertyp ersetzt den allgemeinen RequestInit-Cast; Laufzeitbody und Assertions bleiben gleich.
- `validation5`: Typen/Lint und beide neuen echten Siebenerfolgen bestehen. Quellenreview findet danach fehlende Proxy-Anbindung. `proxy-red` scheitert tatsächlich am ersten neuen Importpfad. Ausschließlich die exakten Matcher-Ausnahmen werden ergänzt; dieselbe erweiterte Gegenprobe besteht in `validation7`, einschließlich weiterhin geschützter Nachbarn und zusätzlicher Segmente.

## Quellen und Originale

Private Originalbelege: `/private/var/folders/bx/tjzzmjhn2qdcdyfc_l7hkv900000gn/T/canvas-m1-explicit-import-fth9eock`. `slice-acceptance.json` bindet Quellen und Terminal-/Abschlussartefakte. Die früheren roten Originale bleiben erhalten und werden nicht als spätere grüne Prüfung ausgegeben.

| Produkt-/Testquelle | SHA-256 |
| --- | --- |
| `app/api/documents/import-existing/route.ts` | `78cee98dc3c0d902841e44610e662756686b059d395b4a0664e6f0787f9e4365` |
| `app/api/documents/import-existing/status/route.ts` | `2549d14b78f6928053a95f78b58f3af94f702a559376557a02b07b2d442a51ec` |
| `app/lib/collaboration/markdown-original-import-contract.ts` | `65cb99018fc46fe9cd3ca8e49ea74c70926a4c00847b6c314925806eac6b6094` |
| `app/lib/collaboration/markdown-original-import-history.ts` | `058df55b0b95bc3b62e4ff043c6bd6d6557d782dd8c5fbb3c962b90ea2f350b8` |
| `app/lib/db/markdown-original-import-migration.ts` | `c9a1dc602c9342ba4833e57fb1ea101f97d3d7988104d320ac3cd339f942cbb8` |
| `app/lib/documents/original-markdown-import-http.ts` | `428ae8b60d50a8485587286330f63e940d01ed744e3044465e96cdeb9397b1e4` |
| `scripts/explicit-original-markdown-import-http-postgres-test.ts` | `c116dd20079be00df23e8d42255a60341dc4962f20d880030900417c8e4ea56f` |
| `scripts/explicit-original-markdown-import-postgres-test.ts` | `d7022b4a6fbb6be00288bef8e6209a03d9fcf2271f34510f76f10eb402d88b96` |
| `app/lib/collaboration/markdown-file-import-persistence.ts` | `417e7bc8f12d6447029b459244692ae5437d064cbe8222271706ec6ade8217ba` |
| `app/lib/db/postgres.ts` | `28fb6cb73a76c1c85bd1d2b2f062f07c122bd058015fcfb0fbcb3b4ead99f590` |
| `proxy.ts` | `04e94afd090851db7ffdc0492dfd8055234182a6326671f821673b21a9be69fe` |
| `scripts/document-read-http-boundary-test.ts` | `2aa2fc7d0f2508663c101c40c58db0e202bbe2f01a4cb69688cf7c61a6825037` |
| `scripts/run-document-read-tool-dispatch-test.mjs` | `5819de7dcd274f07d11f2bff57d3e1a310d71c43222594b81d6bc9b99e9068c7` |

| Originalartefakt | SHA-256 |
| --- | --- |
| `validation7/terminal.json` | `19eb0db7c62d182151877d53d98c1fe6ad8c632678a894441d58e169f23904d3` |
| `validation7/service-resource-report.json` | `ab8f0bc03d5b4fb7eb020f20e661a04f4ddf963901c27f3215f32cb467392402` |
| `validation7/http-resource-report.json` | `9454e578f27ca7e876045b65544b4fa1ba8b1842492a22b89ab47dc1b9d6d3d1` |
| `validation6/terminal.json` | `a926d2f921775acb334536ec34029ea1ddcb3426cc781cee54e4b6003e752317` |
| `validation6/resource-before.json` | `ee6262026d0b6443b37baeff4908d32a036eab0ef124b6953efebb34c9acf878` |
| `validation6/resource-after.json` | `ee6262026d0b6443b37baeff4908d32a036eab0ef124b6953efebb34c9acf878` |
| `slice-acceptance.json` | `15dde40b7859477bef87dd94c728250b28e24ce8e124e73b7394c23e9463a068` |
