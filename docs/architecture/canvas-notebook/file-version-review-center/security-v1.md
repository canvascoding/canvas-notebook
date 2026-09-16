# File Version & Review Center: Capability- und Sicherheitsbaseline V1

Stand: 2026-09-14

Status: fuer `FVRC-G00-CONTRACTS` festgeschrieben

Diese Baseline bindet Produkt, API und spaetere Storage-Implementierung an
fail-closed Entscheidungen. Die ausfuehrbare Referenz liegt in
`app/lib/file-version-center/policy-v1.ts`; die Entscheidungstabellen liegen in
`app/lib/file-version-center/fixtures/file-version-center-policy-v1.json`.

## 1. Verbindliche Sicherheitsinvarianten

1. Eine ID ist nur ein Locator, niemals ein Berechtigungsnachweis.
2. Autorisierung erfolgt serverseitig vor Existenz-, Timeline-, Preview- oder
   Diff-Auskunft und erneut unmittelbar vor jeder Mutation.
3. Angefragter, authentifizierter und nach Aufloesung gefundener Workspace
   muessen identisch sein. Ungeklaerte oder entzogene Rechte werden abgelehnt.
4. Deep Links, Chat-Widgets und spaetere Notifications enthalten nur
   versionierte, serialisierbare Referenzen. Sie enthalten weder Inhalte noch
   absolute Pfade, Tokens oder Grants.
5. Compare, Apply und Restore werden gegen einen frischen Current-Fence
   ausgefuehrt. Ein veralteter Hash, State Vector oder Lifecycle fuehrt zu
   `FVRC_STALE_CURRENT`, nicht zu einem stillen Ueberschreiben.
6. Restore sichert zuerst den aktuellen autoritativen Stand und erzeugt dann
   eine neue Revision mit Quelle `restore`. Historie wird nicht umgeschrieben.
7. Fehlende Policy, ungeklaerte Policy oder Persistenzstoerung bedeuten
   `review_required`. `safe_direct` ist niemals ein Verfuegbarkeits-Fallback.
8. Nicht sicher persistierbare direkte Agentenaenderungen und Restores werden
   nicht ausgefuehrt. Ein Vorschlag darf nur dann in `needs_review` wechseln,
   wenn auch dessen Referenz und Inhalt dauerhaft gespeichert werden koennen.
9. Jede API-Route validiert den V1-TypeBox-Contract, authentifiziert selbst und
   autorisiert Objekt und Workspace. UI-State und Next.js-Middleware allein sind
   keine Sicherheitsgrenze.

## 2. V1-Capability-Matrix

Eine Extension allein schaltet keine Funktion frei. Der Server prueft zuerst
Scope, Lineage, Dateigroesse, Rolloutmodus, Berechtigungen und die Bereitschaft
jedes benoetigten Backends. Der Client rendert ausschliesslich die zurueckgegebene
Capability.

| Klasse | Extensions / Erkennung | History | Compare | Restore | Review-Policy | Preview | V1-Entscheidung |
| --- | --- | ---: | ---: | ---: | ---: | --- | --- |
| Markdown | `.md`, `.markdown` | ja | ja | ja | ja | bereinigtes Markdown | Kernumfang, wenn das jeweilige Backend bereit ist |
| Plain Text | `.txt` | ja | ja | ja | ja | inertes Plain Text | Kernumfang, wenn das jeweilige Backend bereit ist |
| Code / strukturiertes Textformat | unter anderem `.mdx`, `.json`, `.yaml`, `.yml`, Sourcecode | nein | nein | nein | nein | keine Inhaltsvorschau | auf `FVRC-P09` verschoben |
| Office | unter anderem `.docx`, `.xlsx`, `.pptx`, ODF, `.csv` | nein | nein | nein | nein | keine Inhaltsvorschau | strukturierter Diff und sichere Restore-Adapter fehlen |
| Binaer | alle uebrigen Formate | nein | nein | nein | nein | keine Inhaltsvorschau | Content-Diff ist nicht Teil von V1 |

Zusaetzliche Regeln:

- Leserechte erlauben nur History und Compare. Restore und Policy-Aenderung
  benoetigen aktuelle Schreibrechte.
- `read_only` im Rollout deaktiviert Restore und Policy-Aenderung auch fuer
  schreibberechtigte Nutzer.
- Ein nicht bereites Storage-Backend deaktiviert alle Funktionen. Ein nicht
  bereites Compare-, Restore- oder Policy-Backend deaktiviert genau diese
  Funktion.
- Dateien ueber dem Raw-Limit werden nicht teilweise geladen oder im Browser
  vollstaendig verglichen.
- Fehlende Lineage liefert keine spekulative Pfad-Historie. Ihre Anlage ist eine
  getrennte, spaetere Capture-Operation.

## 3. Konkrete Limits

| Grenze | Wert | Verhalten bei Ueberschreitung |
| --- | ---: | --- |
| Raw-Inhalt pro Version | 1 MiB | Capture wird abgelehnt; kein stilles Truncation |
| gespeicherter Blob pro Version | 1 MiB + 64 KiB | Capture wird abgelehnt |
| komprimierte Inhalte pro Lineage | 128 MiB | nur sicher loeschbare Auto-Checkpoints werden zuerst entfernt, sonst Ablehnung |
| komprimierte Inhalte pro Workspace | 4 GiB | wie Lineage-Quota; geschuetzte Versionen bleiben erhalten |
| Versionen pro Lineage | 500 | nur loeschbare Auto-Checkpoints schaffen Platz, sonst Ablehnung |
| geschuetzter neuester Floor | 100 Versionen | wird nie durch automatische Retention unterschritten |
| Auto-Checkpoint-Intervall | mindestens 60 Sekunden | haeufigere unveraenderte Checkpoints werden nicht angelegt |
| Auto-Checkpoint-Inhaltsretention | 90 Tage | danach nur ausserhalb des neuesten Floors loeschbar |
| Grace Period archivierter Lineages | 30 Tage | innerhalb des Fensters keine automatische Inhaltsloeschung |
| Audit-Metadaten | 365 Tage | Inhaltsloeschung entfernt nicht vorzeitig die Auditspur |
| Compare-Inhalt pro Seite | 1 MiB | Compare wird abgelehnt bzw. als nicht verfuegbar markiert |
| Compare-Inhalt kombiniert | 2 MiB | wie oben |
| Zeilen pro Compare-Seite | 20.000 | wie oben |
| Diff-Hunks insgesamt | 2.000 | kein unbeschraenktes Diff; serverseitige Abbruchantwort |
| Diff-Hunks pro API-Seite | 64 | paginiert gemaess Contract V1 |
| Zeilen pro Hunk | 500 | paginiert gemaess Contract V1 |

Bytes sind unkomprimierte UTF-8-Bytes, sofern die Tabelle nicht ausdruecklich
`komprimiert` sagt. Die spaetere Storage-Schicht muss Groessen vor und nach
Kompression pruefen und darf sich nicht auf vom Client gelieferte Werte
verlassen. Hash-Deduplizierung reduziert reale Belegung, aendert aber nicht die
Raw- oder Blob-Einzelgrenze.

Teure Routen werden serverseitig sowohl pro Nutzer als auch pro IP begrenzt:

| Route/Operation | pro Nutzer und Minute | pro IP und Minute |
| --- | ---: | ---: |
| Timeline | 120 | 600 |
| Compare | 30 | 120 |
| Restore | 10 | 60 |
| Policy-Aenderung | 30 | 120 |

Die Zaehler liegen nicht in clientbeschreibbaren Tabellen. `429` verwendet den
stabilen Fehlercode `FVRC_RATE_LIMITED`. Ratenbegrenzung ersetzt weder die
Groessenlimits noch die Objektberechtigung.

## 4. Retention- und Quota-Regeln

Automatisch geschuetzt sind die Quellen `initial`, `manual`, `agent_apply`,
`restore`, `external_import` und `legacy_guest`. Ebenfalls geschuetzt sind
Versionen, auf die ein ausstehendes Review verweist, sowie die neuesten 100
Versionen einer Lineage.

Nur `automatic_checkpoint` ist automatisch loeschbar, und nur wenn gleichzeitig:

- kein ausstehendes Review darauf verweist,
- die Version ausserhalb der neuesten 100 liegt,
- sie aelter als 90 Tage ist,
- bei einer archivierten Lineage die 30-taegige Grace Period abgelaufen ist.

Quota-Admission zieht ausschliesslich so ermittelte, sicher loeschbare Bytes und
Versionen ab. Reicht das nicht, wird der neue Capture abgelehnt. Geschuetzte
Versionen werden nicht still geloescht. Der 365-taegige Audit-Datensatz darf nach
einer zulaessigen Inhaltsloeschung `metadata_only` anzeigen.

## 5. Effektive Review-Policy

Die serverseitige Praezedenz ist verbindlich, von stark nach schwach:

| Rang | Bedingung | Ergebnis | UI |
| ---: | --- | --- | --- |
| 1 | Hard-Safety-Bedingung, zum Beispiel stale Fence oder Konflikt | `review_required` | gesperrt fuer diese Operation |
| 2 | Policy-/Persistenzstatus fehlt, ist unbekannt oder fehlerhaft | `review_required` | gesperrt, Fehlertext sichtbar |
| 3 | Workspace-/Organisationsrichtlinie erzwingt Review | `review_required` | gesperrt mit Richtlinienhinweis |
| 4 | Operation fordert explizit Review | `review_required` | gesperrt fuer diese Operation |
| 5 | geladene Nutzerpraeferenz | `review_required` oder `safe_direct` | umschaltbar |
| 6 | keine gespeicherte Praeferenz | `review_required` | umschaltbarer Default |

Der Toggle veraendert nur zukuenftige Agentenoperationen des Tupels
`userId + workspaceId + lineageId`. Bestehende Vorschlaege werden nicht
automatisch angenommen.

Verbindlicher Defaulttext:

- Label: **Agenten-Aenderungen pruefen** (in der UI mit Umlauten:
  `Agenten-Änderungen prüfen`)
- An: **Pruefung erforderlich** (`Prüfung erforderlich`)
- Aus: **Direkt bearbeiten, wenn sicher**
- Erklaerung: **Gilt für neue Agentenänderungen an diesem Dokument. Konflikte
  und unsichere Änderungen werden weiterhin zur Prüfung vorgelegt.**
- Stoerung: **Prüfung ist vorübergehend erforderlich. Die Einstellung konnte
  nicht sicher geladen werden.**

## 6. Preview-Sicherheitsprofil

Markdown-Preview wird aus bereinigtem Output aufgebaut. Raw HTML, Skripte,
Iframes, Remote-Ressourcen und aktive Links sind aus. Text-Preview interpretiert
kein Markup und fuehrt keinen Inhalt aus. Diese Regeln gelten auch dann, wenn der
aktuelle Editor an anderer Stelle mehr Darstellung erlaubt.

Der Server liefert begrenzte Diff-Hunks. Der Client baut keine Vorschau aus
HTML-Strings und laedt keine Bilder, Fonts, Stylesheets oder Medien aus dem
Dokument. Copy/Download sind getrennte, autorisierte Aktionen und kein
Nebeneffekt des Renderns.

## 7. Threat Model

| ID | Bedrohung | Verbindliche Gegenmassnahme | Spaetere Verifikation |
| --- | --- | --- | --- |
| FVRC-T01 | Erratene Lineage-, Revision-, Operation- oder Change-Group-ID | IDs sind Locator; Scope- und Objektberechtigung vor Existenzantwort | Cross-User-/Cross-Workspace-API-Tests in P01/P02 |
| FVRC-T02 | Deep-Link-Manipulation oder Datenabfluss ueber URL/History | nur Contract-Version, Zielart, Workspace-ID, opaque Referenz und Auswahl; keine Inhalte/Pfade ausser sicherem relativen Path-Hint, keine Tokens | Contract- und Roundtrip-Fixtures |
| FVRC-T03 | Cross-Workspace-Zugriff nach Verschieben oder manipuliertem Target | requested, authenticated und resolved Workspace muessen identisch sein | Scope-Entscheidungstabelle und Routen-Integrationstest |
| FVRC-T04 | Rechteverlust zwischen Laden und Accept/Restore | Rechte und Mitgliedschaft unmittelbar vor Mutation erneut pruefen; unbekannt gilt als denied | Revocation-Race-Test in P01/P02 |
| FVRC-T05 | XSS, Tracking oder Netzwerkzugriff durch Markdown-Preview | Sanitizing; kein Raw HTML, Script, Iframe, Remote-Resource oder aktiver Link | Renderer-Security-Tests in P03 |
| FVRC-T06 | Restore ueberschreibt neuere kollaborative Aenderungen | frischer Current-Fence, CAS/State-Vector-Pruefung, Pre-Restore-Capture, neue Restore-Revision | Parallel- und stale-current-Tests in P02 |
| FVRC-T07 | Agentenvorschlag basiert auf ueberholtem Inhalt | Vorschau immer gegen aktuellen Stand neu berechnen; stale/conflict Status; kein blindes Apply | Agent-Operation-Race-Tests in P02/P04 |
| FVRC-T08 | Existenz-Orakel ueber unterschiedliche Fehler | Autorisierung vor Lookup; fuer unberechtigte Ziele einheitlich `FVRC_ACCESS_DENIED` | Negative API-Matrix in P01 |
| FVRC-T09 | Change Group verweist auf fremde Datei oder andere Reihenfolge | Workspace/Lineage je Entry pruefen; persistierte, lueckenlose Ordinals; keine Client-Grants | Change-Group-Constrainttests in P01 |
| FVRC-T10 | Speicher-, Diff- oder Dekompressions-DoS | Raw-, Blob-, Workspace-, Lineage-, Zeilen- und Hunk-Limits vor teurer Verarbeitung | Oversize-, Quota- und Kompressionsbomben-Tests in P01/P02 |
| FVRC-T11 | Teilweise Persistenz macht nicht wiederherstellbaren Stand sichtbar | Blob atomar schreiben/verifizieren, dann Revision binden; Capture-Pflicht vor Mutation | Crash- und Korruptionstests in P01 |
| FVRC-T12 | Reloaded Chat-Widget zeigt veraltete Rechte oder Status | Widget speichert nur Referenz; Server loest Status und Autorisierung bei jedem Oeffnen neu auf | Reload-, Archive- und Revocation-Tests in P06 |
| FVRC-T13 | Missbrauch teurer Timeline-/Diff-/Restore-Routen | kombinierte Nutzer- und IP-Ratenlimits, harte Inputlimits, keine clientbeschreibbaren Zaehler | Rate-Limit- und Burst-Tests in P02 |

## 8. Rollout und Rollback

Einziger V1-Kernschalter ist `FILE_VERSION_CENTER_MODE`:

| Modus | Capture | sichtbare UI | History/Compare | Restore/Policy-Aenderung |
| --- | ---: | ---: | ---: | ---: |
| fehlt oder leer | ja | ja | ja | ja, jeweils nur bei bereitem Backend |
| unbekannt oder `off` | nein | nein | nein | nein |
| `shadow` | ja | nein | nein | nein |
| `read_only` | ja | ja | ja | nein |
| `full` | ja | ja | ja | ja, jeweils nur bei bereitem Backend |

Notifications sind ausschliesslich in `full` aktiv. Ein explizites
`read_only`, `shadow` oder `off` oeffnet keinen Benachrichtigungskanal.

Der Schalter wird ausschliesslich serverseitig gelesen. Es gibt bewusst kein
`NEXT_PUBLIC_FILE_VERSION_CENTER_MODE`; ein Clientwert kann keine serverseitige
Capability oder Mutation freischalten.

Rollback ist datenbewahrend:

1. Bei einem Mutationsproblem von `full` auf `read_only` wechseln. Neue Restore-
   und Policy-Mutationen werden serverseitig abgelehnt; Historie bleibt lesbar.
2. Bei einem Lese- oder Datenleckrisiko auf `off` wechseln. UI und neue Captures
   sind aus; bestehende Blobs und Metadaten werden nicht geloescht.
3. Bei reinen UI-Problemen kann `read_only` weiterlaufen, waehrend Einstiegspunkte
   deaktiviert werden. Deep Links duerfen den Servermodus nicht umgehen.
4. Eine Rueckkehr zu `full` erfolgt ueber `shadow`, dann `read_only`, erst danach
   `full`. Jeder Schritt benoetigt Backend-Health und negative Autorisierungstests.

Ein Flagwechsel aendert weder gespeicherte Review-Praeferenzen noch akzeptiert er
ausstehende Vorschlaege. Fehlt der Wert, gilt `full`; nur `off` deaktiviert die
Funktion bewusst. Unbekannte Flagwerte fallen weiterhin sicher auf `off` zurueck.

## 9. Gate-Evidenz

`scripts/file-version-center-policy-test.ts` prueft die Capability-, Scope-,
Review-, Retention-, Quota-, Compare- und Rollout-Entscheidungstabellen sowie die
Defaulttexte und das Preview-Profil. Die Baseline implementiert bewusst weder
DB-Schema noch Storage; diese duerfen erst nach `FVRC-G00-CONTRACTS` in
`FVRC-P01` folgen.
