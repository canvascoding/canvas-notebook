# File Version & Review Center: Contract V1

Stand: 2026-09-14

Status: eingefroren durch `FVRC-001`

Die ausfuehrbaren TypeScript-/TypeBox-Schemas liegen unter
`app/lib/file-version-center/contracts`. Dieser Text beschreibt ihre
produktseitige Bedeutung. Breaking Changes erfordern eine neue
`contractVersion` und parallele Migration; V1 wird nicht still umgedeutet.

## 1. Gemeinsamer Open-Contract

Alle UI-Einstiege verwenden `FileVersionCenterRequestV1`. Das Ziel ist eine
discriminated union und dadurch immer eindeutig:

- `lineage`: bevorzugter stabiler History-Einstieg,
- `document`: geoeffnetes kollaboratives Dokument,
- `change_group`: Chat-Widget mit optional vorausgewaehltem Batch-Eintrag,
- `path`: begrenzter workspace-relativer Aufloesungs-Fallback.

Eine optionale Auswahl verweist ausschliesslich auf eine `agent_operation` oder
`revision`. Der Open-Contract enthaelt keine geladenen Inhalte, absoluten
Serverpfade oder Autorisierungs-/Direct-Edit-Tokens.

Desktop, Tablet und Mobile verwenden denselben Contract. Unterschiede in
Dialoggroesse und Navigation sind reine Darstellung und duerfen keine zweite
Deep-Link- oder API-Form erzeugen.

## 2. Deep-Link V1

V1 verwendet explizite Queryparameter statt eines undurchsichtigen JSON-Blobs:

| Parameter | Bedeutung |
|---|---|
| `fvrc=1` | Contract-Version |
| `fvrcTarget` | `lineage`, `document`, `change_group` oder `path` |
| `fvrcWorkspace` | expliziter Workspace-Scope |
| `fvrcRef` | genau eine opake Ziel-ID oder ein relativer `pathHint` |
| `fvrcChangeEntry` | optionaler Change-Group-Eintrag |
| `fvrcView` | `reviews` oder `history` |
| `fvrcSelectedKind` / `fvrcSelectedId` | optionale Timeline-Auswahl |

Der Parser setzt die Quelle immer auf `deep_link`. Bestehende fremde
Queryparameter und Hash-Fragmente werden beim Hinzufuegen und Entfernen des
FVRC-Intents erhalten.

`pathHint` ist nie Autoritaet. Absolute POSIX-/Windows-/UNC-Pfade, Schemes,
Backslashes, Kontrollzeichen, leere Segmente sowie `.`/`..` werden abgewiesen.
Der Server loest jede Referenz unter der aktuellen Session und dem expliziten
Workspace neu auf.

## 3. API-Oberflaeche

Die eingefrorenen V1-Pfade sind:

```text
POST /api/files/version-center/v1/resolve
POST /api/files/version-center/v1/timeline
POST /api/files/version-center/v1/compare
POST /api/files/version-center/v1/restore
GET|PUT /api/files/version-center/v1/policy
POST /api/files/version-center/v1/change-groups
```

Die Route-Implementierung folgt in spaeteren Paketen. Alle Requests und
Responses tragen `contractVersion: 1`. Mutation-Endpunkte benoetigen aktuelle
Session-, Workspace-, Capability-, Lifecycle- und Fence-Pruefungen und antworten
`private, no-store`.

## 4. Timeline

Die Timeline besitzt drei Entry-Klassen:

1. `agent_operation` mit Status, Proposal-Version, Statistik und
   `actionsAllowed`,
2. `current` mit aktuellem Hash und optionalem State-Vector-Hash,
3. `revision` mit Quelle, Actor, Inhaltsverfuegbarkeit und Restore-Capability.

Die API liefert hoechstens 50 Eintraege je Seite. Reihenfolge und Pinned-
Darstellung sind Server-/Query-Invarianten, nicht Aufgabe der einzelnen
Einstiegskomponenten.

## 5. Vergleich

Jeder Compare-Request enthaelt:

- die Dokumentreferenz,
- genau eine historische Revision oder Agentenoperation als Kandidat,
- den vom Client angezeigten aktuellen Fence,
- optional Cursor und Seitengroesse.

Die Response wiederholt den tatsaechlich verglichenen Current-Fence und die
Kandidatenauswahl. Diff-Hunks sind auf 64 pro Seite, 500 Zeilen pro Hunk und
16.384 Zeichen pro Zeile begrenzt. `truncated` ist explizit; der Browser muss
keine unbeschraenkten Volltexte erhalten.

Die versionierte Fixture enthaelt zwei aufeinanderfolgende Seiten mit
identischem Current-Fence und Kandidaten. Aendert sich einer davon, ist die
Fortsetzung veraltet und muss mit stabilem Fehlercode abgebrochen werden.

## 6. Restore

Der Restore-Request enthaelt Revisions-ID, aktuellen Fence und einen
Idempotency-Key. Die Response unterscheidet `restored` von dem sicheren Retry
`already_restored` und nennt vorherige, neue sowie aktuelle Revision.

Eine erfolgreiche Response darf erst entstehen, nachdem Pre-Restore-Capture,
Adapter-Mutation und neue Revision konsistent bestaetigt wurden. V1 kennt keine
in-place-Wiederherstellung.

## 7. Review-Policy

Die Policy trennt:

- `requestedMode`: Nutzereinstellung,
- `effectiveMode`: nach Hard-Safety und uebergeordneten Regeln,
- `revision`: CAS-Fence,
- `locked` und `reason`: erklaerbarer Override.

Der Update-Contract akzeptiert nur ein Lineage-Ziel und `expectedRevision`.
Ein fehlgeschlagener Read oder eine unbekannte Policy darf niemals implizit
`safe_direct` ergeben.

## 8. Change Group

Eine Change Group verbindet genau einen gespeicherten Tool-Aufruf (`write`,
`edit_file`, `apply_patch`) mit 1 bis 100 geordneten Dokumenteintraegen.
Ordinals beginnen bei null und sind lueckenlos. Jeder Eintrag enthaelt nur IDs,
workspace-relativen Pfadhinweis, Outcome und optionale Zaehler.

`changed: false` erzeugt spaeter keine Change Group. Ein Widget darf den
gespeicherten Status nie als Autorisierung behandeln; es fragt die Entity unter
dem aktuellen Nutzer erneut ab.

## 9. Stabile Fehlercodes

V1 sperrt Fehlercodes fuer Validierung, Version, Ziel, Payloadgroesse, Zugriff,
fehlende Entity/Capability/Inhalt, veralteten Current-/Selection-Fence,
Konflikt, Policy-CAS, Rate Limit, Persistenz und internen Fehler.

Fehlermeldungen sind nutzerlesbar, aber nicht maschinell auszuwerten. Clients
verzweigen nur auf `FVRC_*`-Codes und `retryable`. Fehlerdetails enthalten keine
Dokumenttexte, Diff-Hunks, Dateisystempfade oder Freigabetokens.

## 10. Transport- und Security-Envelopes

- Opake IDs: maximal 128 Zeichen, keine Pfadseparatoren.
- Pfadhinweis: maximal 1.024 Zeichen, workspace-relativ und normalisiert.
- Deep-Link-Query: maximal 4.096 Bytes.
- JSON-Payload: maximal 512 KiB.
- Cursor: maximal 512 Zeichen.
- Idempotency-Key: 16 bis 128 Zeichen.
- Unknown Properties werden von allen V1-Schemas abgewiesen.

Diese Werte sind harte Transportobergrenzen. Die in `FVRC-002` festgelegten
Produkt-, Storage-, Quota- und Retention-Grenzen duerfen strenger, aber nicht
hoeher sein.

## 11. Kompatibilitaetsreview

| Client | Ergebnis |
|---|---|
| Desktop-Editor | Dokument- und Lineage-Ziel, Reviews und Historie ohne Routennavigation abbildbar |
| Desktop-Dateibrowser | Lineage beziehungsweise sicherer Pfad-Fallback abbildbar |
| Desktop-/Mobile-Chat | Persistierte Change Group und Batch-Entry abbildbar |
| Mobile Vollbilddialog | Identischer Request; keine desktop-spezifischen Felder |
| Notification, spaeter | Operation-/Change-Group-Auswahl ohne Inhaltsdaten abbildbar |
| Reload / Copy Link | Versionierte Query bleibt lesbar und fremde Query-/Hash-Werte bleiben erhalten |

Die Fixture- und Roundtrip-Tests pruefen positive Zielvarianten, paginierte
Hunks, absolute/traversierende Pfade, verbotene Inhalts-/Grant-Felder,
unbekannte Versionen sowie uebergrosse Payloads, Zeilen und Hunk-Seiten.
