# Review-Toggle, Default-Direktbearbeitung und offene Abhängigkeiten

Stand: 26. September 2026. Ausgangscommit `4d6c10b0d`; Teil von FVRC-1008,
keine vollständige Abnahme oder Produktionsfreigabe.

## Produktbefund und Fix

Ein neues Dokument zeigt korrekt den ausgeschalteten Review-Toggle, besitzt
aber noch keine Zeile in `file_agent_review_policies`. Der Operationsresolver
verlangte bisher eine solche Zeile für jede Direktfreigabe. Der erste gewöhnliche
Edit scheiterte deshalb trotz `default_safe_direct` mit
`PROPOSAL_UPGRADE_REQUIRED`. Der erste Browserlauf reproduzierte diesen Fehler.

Der Adapter erfasst jetzt vor Lesen und Queueing einen serverseitigen Zeitpunkt.
Ohne gespeicherte Präferenz gilt die beobachtete Revision **0**, und nur eine
danach neu angelegte, exakt zugeordnete `preparing`-/`direct_apply`-Operation
kommt für eine Freigabe infrage. Bestehende Präferenzen behalten ihren
gespeicherten Revisions-/Zeitvergleich. Ein zwischenzeitlicher Toggle invalidiert
den alten Snapshot. Reads erzeugen weder Präferenzzeilen noch fingierte
Benutzerentscheidungen/Audit-Einträge.

Owner, Workspace, aktive Lineage, Dokument, Actor, Session, Generation und
Operationstyp bleiben gebunden. Ein vorhandener idempotenter Vorgang kehrt
bereits vor der Autorisierung zurück. Der zusätzliche Zeitvergleich allein ist
keine Freigabe: frische Session-/Workspace-Rechte, gültiger operationsgebundener
Grant und die spätere direkte Verbindung werden weiterhin separat geprüft.
Gleiche Millisekunde, ungültiger Zeitwert oder verlorene Rechte verweigern.
Snapshot und Neuanlage erfolgen im selben Request-Worker; eine neue verteilte
Ordnungs-/Clock-Synchronisationsgarantie wird damit nicht eingeführt.

Die PGlite-Serviceprüfung deckt insbesondere alte/gleichzeitige Operationen,
fehlende/ungültige Beobachtung, falsche Revision, fremde Eigentümer/Scopes,
`queued`, bereits reviewpflichtige Vorgänge und expliziten Review-Modus ab.
Policy-Race, abgelaufene/widerrufene Grants, harte Sicherheitsregeln und der
`force_review`-Vertrag bleiben geschlossen. Der Adaptertest prüft die exakte
Weitergabe des serverseitigen Zeitpunkts. Ein unabhängiger Quellreview fand
keinen konkreten Default-/Replay-Bypass.

## Gefundene Harness-Grenze

Nach dem Policy-Fix konnte der bisherige separate Tool-Prozess weiterhin keinen
direkten Edit ausführen: `runCollaborationDirectConnection` benötigt einen
prozesslokalen Handler des laufenden Collaboration-Servers. Der Child-Prozess
hatte diesen Handler nicht; `needs_review`/`persistence_degraded` war deshalb
kein erfolgreicher Direkt-Edit und wurde nicht als solcher gewertet. Außerdem
wurde das anfänglich falsche Testorakel `operationStatus: applied` auf den
existierenden dauerhaften Vertragswert `persisted_yjs` korrigiert.

`scripts/collaboration-agent-test-host.ts` ist ein expliziter **Test-Launcher**,
kein Import des normalen Produktstarts und kein neuer HTTP-Endpunkt. Er startet
den bestehenden Server und die registrierten `read`-/`edit_file`-Werkzeuge im
selben Prozess. Dadurch werden die echte Room-Verbindung, Rechteprüfung, Yjs-
Persistenz und History genutzt; keine simulierte Apply-/Persistenzgrenze.

- Nur Development, ausdrückliche E2E-/Local-Test-Schalter, Loopback-Port 3000 und
  verwaltetes PostgreSQL `127.0.0.1:55433/canvas_notebook` sind zulässig.
- Ein besetzter App-Port wird **vor** dem Serverimport abgewiesen. Der private
  Socket wird erst nach gesunder HTTP-/Collaboration-Bereitschaft angeboten.
- `mkdtemp`-Verzeichnis 0700, Unix-Socket 0600, keine TCP-Tool-Schnittstelle.
- Nur exakt an ihren Dateinamen gebundene API-Test-Sessions, die nach dem
  Launcherstart erstellt wurden; ausschließlich UUID-Markdown-Testdateien.
  Aktuelle Rechte und Root werden aus der gespeicherten Session abgeleitet,
  nicht aus den vom Test übergebenen Permission-/Root-Feldern übernommen.
- Eine Anfrage pro Verbindung, Größen-/Zeitgrenzen, redigierte Fehler, keine
  automatischen Retries. Ein Timeout ist ein **unbekanntes Ergebnis**, keine
  Aufforderung zur erneuten Ausführung mit neuer ID; zuerst Zustand prüfen.
- Reguläre Graph-off-/Child-Prozess-Tests behalten ihren bisherigen Transport.
  Der In-Process-Pfad wird nur ausdrücklich gewählt und fällt nie still zurück.

Der bestehende Dev-Server wurde für diesen Lauf ersetzt, nicht parallel ergänzt.
Container, Datenbankkonfiguration und Produktionsgates wurden nicht geändert.

## Browserorakel

`tests/file-version-center-ordinary-toggle.spec.ts` prüft Personal und Team mit
echten APIs, gewöhnlichen registrierten Tools und dem verwalteten PostgreSQL:

1. Neues Dokument, Review unangetastet **aus**: Notiz `offen → gelesen` wird
   direkt dauerhaft gespeichert; keine Proposal-Anlage, genau eine Revision.
2. Toggle **an**: Root ändert Kosten 10 → 12; Child erweitert die Deckung
   100 → 150 auf Root-Basis, ohne aktuellen Dokumentinhalt zu ändern.
3. Toggle **aus**: beide bleiben offen, Graphrevision/Abschlussmenge unverändert.
   Ein identischer Root-Tool-Retry bleibt reviewpflichtig. Ein explizites weiteres
   Child (Deckung 150 → 175) bleibt ebenfalls reviewpflichtig.
4. Neuer unabhängiger gewöhnlicher Edit (Lieferzeit 5 → 3) wird direkt gespeichert.
   Die davor gezeigte Annahme wird mit `PROPOSAL_CURRENT_CHANGED` abgewiesen,
   ohne weiteren Inhaltseffekt/Revision. Frischer Vergleich: `clean_rebased`.
5. Toggle wieder **an**: neue unabhängige Notizänderung `gelesen → bereit` wird
   vorgeschlagen. UI „Review all changes“ zeigt alle vier offenen Vorschläge.
6. Explizite Bestätigung nimmt genau diese vier IDs gemeinsam an: ein UI-POST,
   ein dauerhafter Batch-Beleg, eine zusätzliche Inhaltsrevision. Identischer
   Aktions-Retry liefert denselben Beleg ohne weiteren Effekt.

Festes Endergebnis: Kosten **12 EUR**, Lieferzeit **3 Tage**, Deckung **175 EUR**,
Notiz **bereit**. Vollständiger Markdowntext, alle fünf ursprünglichen Block-IDs,
Blockreihenfolge, exakte Receipt-/Resolution-ID-Mengen und insgesamt **+3**
Inhaltsrevisionen (zwei direkte Edits plus ein Batch) werden separat geprüft.
Eigene UUID-Dateien/Sessions werden per API entfernt; kein Fixture-Reset.

## Laufnachweise und Grenzen

Erste erfolgreiche Läufe auf Host-Dev **127.0.0.1:3000**:
Personal `toggle-personal-r5` 26,0 s, Team `toggle-team-r1` 19,0 s.
HTML-Berichte: `/tmp/fvrc1008-<Laufname>-report/index.html`.
Nach der Launcher-Härtung wurde auch der Session-Zeitfilter korrigiert:
`pi_sessions.created_at` ist ein bigint in Millisekunden; ein JavaScript-Date-
Objekt war kein gültiger SQL-Parameter dafür. Der zusätzliche Hosttest verlangt
jetzt ausdrücklich eine sichere Ganzzahl. Der finale Personal-Lauf
`toggle-personal-r7` besteht (24,4 s), ebenso `toggle-team-r2` (18,0 s).
Beide finalen JSON-Belege wurden direkt aus dem Report zusätzlich auf Endtext,
exakte IDs, +3 Revisionen, fünf Block-IDs, einen UI-POST und Stale-Code geprüft.
Die Fälle liefen seriell mit mindestens 55 Sekunden Abstand.

Der bestehende Personal-Auswahlgruppen-/Nachfahrenfall besteht ebenfalls
(`toggle-choice-regression-r1`, 43,4 s), mit unverändertem Child-Prozess-Transport.
Beide Sammelvorschauen wurden visuell geprüft: offene Zweige und aktuelle Version
sind unterscheidbar, echte Diffs sichtbar und die gemeinsame Annahme erreichbar.
Kein beobachteter Review-429-/5xx-Fehler in den bestandenen Browserfällen.

`test:collaboration:agent-approval`, `test:proposal-graph:tools` und
`test:proposal-graph:review-actions` bestehen. Policy-Service und drei Adaptertests
sowie acht echte Unix-Transporttests und sechs isolierte Tests des Launcher-
Quellcodes bestehen (`/tmp/fvrc1008-toggle-harness-final.log`). Die Launcher-
Tests simulieren Infrastruktur, die Browserläufe dagegen nicht.
Der Build besteht mit 353 Seiten;
vollständiges Lint: null Fehler, sieben bestehende Warnungen außerhalb dieser
Änderungen. TypeScript ohne inkrementellen Cache besteht. Logs liegen unter
`/tmp/fvrc1008-toggle-{approval,tools,review-actions,build,lint}-r1.log`.

**Offen bleibt:** vollständiger Browserablauf mit tatsächlich abgelaufenem Grant;
strengere Workspace-Policy im Produktpfad. Letztere ist nicht nur ein fehlender
Test: `force_review` existiert im Vertragsresolver, aber Timeline und Agent-Adapter
liefern aktuell `allow_user_choice`; ein verbindlicher Workspace-Policy-Provider
ist dort nicht angeschlossen. Der neue Default-Fix behauptet keine Behebung
dieser separaten Integration. PG-S22/MR-24 bleiben deshalb **teilweise abgedeckt**.
Zwei Gesamtmatrixläufe, frisches Produktionsimage (3100 ist weiterhin alt), P12
und Produktionsaktivierung bleiben offen. Kein Push und kein Containerneubau.

## Wiederholung und Quellzuordnung

Den eigenen normalen Dev-Server vorher geordnet beenden; nicht neben ihm einen
weiteren App-Prozess starten. Aus dem vorgesehenen Worktree, mit den privaten
bereits vorbereiteten Skill-Env-Dateien (keine Secrets in Git):

```sh
NODE_ENV=development COLLABORATION_E2E=1 CANVAS_PROPOSAL_REVIEW_LOCAL_TEST=1 \
CANVAS_ENV_FILE=/Users/frankalexanderweber/.local/state/canvas-local-team-seat/notebook-host-dev.env \
node --env-file=/Users/frankalexanderweber/.local/state/canvas-local-team-seat/notebook-host-dev.env \
  --import tsx scripts/collaboration-agent-test-host.ts
```

Der Launcher meldet erst nach Readiness seinen temporären Socket. Dessen exakten
Pfad für den Testprozess als `CANVAS_LOCAL_AGENT_TOOL_SOCKET` setzen. Dann mit
`NODE_ENV=development`, `E2E_EXTERNAL_SERVER=1`, `COLLABORATION_E2E=1`,
`CANVAS_PROPOSAL_REVIEW_LOCAL_TEST=1`, `BASE_URL=http://127.0.0.1:3000` und beiden
`--env-file`-Argumenten (`notebook-host-dev.env`, `fixtures.env`) ausführen:

```sh
node --env-file=/Users/frankalexanderweber/.local/state/canvas-local-team-seat/notebook-host-dev.env \
  --env-file=/Users/frankalexanderweber/.local/state/canvas-local-team-seat/fixtures.env \
  node_modules/@playwright/test/cli.js test tests/file-version-center-ordinary-toggle.spec.ts \
  --grep personal --workers=1 --reporter=line,html
```

Danach mindestens 55 Sekunden Abstand und denselben Aufruf mit `--grep team`.
Nach Abschluss den Test-Launcher geordnet beenden und den normalen Dev-Server
wieder starten. Der finale Lauf prüfte die Entfernung seines privaten Sockets
und Verzeichnisses. Dies ersetzt keinen Neustart-/Recovery-Test offener Aktionen.

Unveränderte ausgeführte Produkt-/Browsersourcen, SHA-256:

- `agent-review-policy-adapter.ts`: `0cfe3fb30352bf06d04d58238b6004e3c40a202e591b899e0a2f23e032b031e2`
- `review-policy-service.ts`: `5540bc82dc1be76220363a82bd9d9d68e57cf69a661988953fe320f25ebade4b`
- `collaboration-agent-test-host.ts`: `31716be9248ebdae66be64d7413e2751fc365ee03ed3a3c97e5098e0cac84cce`
- `file-version-center-ordinary-toggle.spec.ts`: `de6a0505b3ec5b3d79a05a1f37505d776dba1fb6bf91d654a5000820636d3ee3`

Der erneuerte GitNexus-Index meldet für den staged Umfang 14 Dateien,
96 Symbole, keine zusätzlich zugeordneten Prozesse und niedriges Risiko.
Das ersetzt die vorherige symbolbezogene **HIGH**-Einschätzung des zentralen
Policy-Adapters nicht. Der ganze Branchvergleich zum lokalen `main` umfasst
185 Dateien, 1416 Symbole und 27 Prozesse und bleibt **kritisch**. Dieser Commit
ist keine Freigabe für den gesamten Branch. Generierte Indexzählungen in
`AGENTS.md` und `CLAUDE.md` werden nicht mitcommitted.
