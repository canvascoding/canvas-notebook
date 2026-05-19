# Managed Photo & Video Generation

## Ziel

Canvas Studio soll Bilder und Videos weiterhin wie bisher nutzen: gleiche UI, gleiche Provider-Auswahl, gleiche Studio-API und gleiche lokale Speicherung der Outputs im Notebook.

Wenn der Managed Mode aktiv ist und der jeweilige lokale Provider-Key in `/data/secrets/Canvas-Integrations.env` fehlt, soll Notebook automatisch als Fallback die Canvas Control Plane verwenden. Der User soll nicht extra "Control Plane" als Provider auswählen müssen.

Lokale User-Keys haben immer Vorrang. Wenn ein Key lokal gesetzt ist, geht der Request direkt vom Notebook zum Provider.

## Ausgangslage

- Notebook verwaltet Studio-State, lokale Assets, `studio_generations` und `studio_generation_outputs`.
- Control Plane verwaltet bereits Managed Chat Provider, VM-Tokens, Secrets, Usage-Events und Pricing-Metadaten.
- VM-Instanzen besitzen bereits ein Managed-Service-Token, das als Bearer Token gegenüber der Control Plane verwendet werden kann.
- Control Plane kennt bereits Scopes wie `openai:image`, `gemini:image`, `gemini:video` und `kie:video`.

## Grundentscheidung

Die Control Plane wird nicht als sichtbarer Studio-Provider eingeführt. Stattdessen wird sie eine unsichtbare Fallback-Schicht für Provider-Credentials und Provider-Execution.

Notebook entscheidet pro Request:

1. Provider wie bisher bestimmen, z.B. `gemini`, `openai`, `veo`, `bytedance`.
2. Prüfen, ob der lokale Provider-Key in `Canvas-Integrations.env` gesetzt ist.
3. Wenn ja: direkte lokale Provider-Integration nutzen.
4. Wenn nein und `CANVAS_MANAGED_SERVICES_ENABLED=true`: Managed Fallback über Control Plane nutzen.
5. Wenn nein und Managed Fallback nicht verfügbar ist: klare Fehlermeldung mit Link zu `/settings?tab=integrations`.

## Unterstützte Provider in Phase 1

- Gemini Image Generation
- OpenAI Image Generation
- Gemini Veo Video Generation
- KIE / Seedance Video Generation

## Control-Plane API

Die beste Lösung ist eine generische Media-Generation-API statt einzelner provider-spezifischer Endpoints. Dadurch können später weitere Provider ergänzt werden, ohne dass Notebook neue Endpoint-Familien kennen muss.

Vorgeschlagene Endpoints:

```text
POST /v1/managed/media-generations
GET  /v1/managed/media-generations/:jobId
GET  /v1/managed/media-generations/:jobId/outputs/:outputId
POST /v1/managed/media-generations/:jobId/ack
```

### `POST /v1/managed/media-generations`

Erstellt einen Managed Media Job.

Request-Felder:

- `capability`: `image` oder `video`
- `provider`: `gemini`, `openai`, `kie`
- `model`
- `prompt`
- `parameters`: provider-neutrale und provider-spezifische Parameter
- `references`: Referenzbilder oder Upload-Handles
- `clientGenerationId`: Notebook-Generation-ID zur Korrelation

Auth:

- Bearer Token aus `CANVAS_INSTANCE_TOKEN`
- Scope-Prüfung je nach Provider/Capability:
  - Gemini Image: `gemini:image`
  - OpenAI Image: `openai:image`
  - Gemini Video: `gemini:video`
  - KIE Video: `kie:video`

Response:

```json
{
  "jobId": "uuid",
  "status": "queued"
}
```

### `GET /v1/managed/media-generations/:jobId`

Liefert den aktuellen Status.

Statuswerte:

- `queued`
- `running`
- `waiting_upstream`
- `succeeded`
- `failed`
- `expired`

Bei Erfolg enthält die Response eine Output-Liste mit Download-Endpunkten, aber keine dauerhaft gespeicherten Medien-URLs.

### `GET /v1/managed/media-generations/:jobId/outputs/:outputId`

Notebook lädt fertige Bilder oder Videos herunter und speichert sie lokal im Studio-Workspace.

### `POST /v1/managed/media-generations/:jobId/ack`

Notebook bestätigt, dass alle Outputs erfolgreich lokal gespeichert wurden. Danach darf Control Plane temporäre Output-Dateien löschen.

## Queue-Architektur

Für Phase 1 sollte kein Redis-Container eingeführt werden.

Die robusteste pragmatische Lösung ist eine Postgres-basierte Queue, weil Control Plane bereits Postgres und Drizzle verwendet. Video-Generierung ist langsam und Provider-limitiert; Redis würde hier erstmal mehr Betriebsaufwand als Nutzen bringen.

### Job-Tabelle

Neue Tabelle: `managed_media_generation_jobs`

Wichtige Felder:

- `id`
- `vmId`
- `capability`
- `provider`
- `model`
- `status`
- `requestPayload`
- `normalizedParameters`
- `referenceCount`
- `inputBytes`
- `outputCount`
- `outputBytes`
- `upstreamOperationId`
- `upstreamTaskId`
- `upstreamRequestId`
- `attempts`
- `nextAttemptAt`
- `leaseOwner`
- `leaseUntil`
- `lastHeartbeatAt`
- `startedAt`
- `completedAt`
- `failedAt`
- `errorCode`
- `errorMessage`
- `metadata`
- `createdAt`
- `updatedAt`

### Worker-Verhalten

Worker holen Jobs mit Lease-Locking:

```sql
FOR UPDATE SKIP LOCKED
```

Das verhindert, dass mehrere Worker denselben Job bearbeiten. Wenn ein Worker abstürzt, läuft `leaseUntil` ab und ein anderer Worker kann übernehmen.

### Lange Video-Jobs

Der Worker soll nicht 10 Minuten blockierend warten.

Stattdessen:

1. Worker startet upstream Provider-Job.
2. Control Plane speichert `upstreamOperationId` oder `upstreamTaskId`.
3. Job geht auf `waiting_upstream`.
4. `nextAttemptAt` wird auf den nächsten Poll-Zeitpunkt gesetzt.
5. Ein Worker pollt später weiter.
6. Bei Erfolg werden Outputs temporär in Control Plane gespeichert.
7. Notebook lädt Outputs herunter und bestätigt mit `ack`.

Das ist restart-sicher, ressourcenschonend und passt besser zu langen Video-Generierungen.

## Medien-Transfer

Notebook soll die endgültigen Bilder und Videos speichern. Control Plane soll Medien nur temporär halten, damit Notebook sie abholen kann.

### Referenzen

Für Referenzbilder ist `multipart/form-data` die robusteste Standardlösung.

Warum:

- Kein Base64-Overhead.
- Besser für große Bilder und spätere Videos.
- Weniger Speicherverbrauch in Node-Prozessen.
- Sauberere Limits pro Datei und Request.

Control Plane kann kleine JSON/Base64-Payloads als Kompatibilitätsoption akzeptieren, aber Notebook sollte für neue Managed-Fallback-Requests Multipart verwenden.

### Temporäre Ablage

Phase 1:

- temporäres lokales Storage-Verzeichnis auf der Control Plane
- Dateipfade nur intern speichern
- Downloads nur authentifiziert über Job-Output-Endpoint

Spätere Skalierung:

- R2 oder S3-kompatibler Storage
- signed URLs intern oder kontrolliert über API

## Retention

Vorschlag:

- Erfolgreiche Outputs: nach `ack` sofort löschen.
- Nicht abgeholte erfolgreiche Outputs: 24 Stunden behalten.
- Inputs/Referenzen fehlgeschlagener Jobs: 24 Stunden behalten, damit Debugging möglich bleibt.
- Job-Metadaten und Usage-Daten: mindestens 180 Tage behalten.
- Prompts: standardmäßig nur kurzer Preview, Länge und Hash speichern.
- Vollständige Prompts nur mit explizitem Control-Plane-Schalter speichern, z.B. `MANAGED_MEDIA_STORE_FULL_PROMPTS=true`.

Damit bleiben Abrechnung und Auswertung möglich, ohne dass Control Plane unnötig viele User-Medien dauerhaft hält.

## Usage & Billing

Media-Jobs sollen in die vorhandene Managed-Usage-Auswertung integriert werden.

`managed_usage_events.capability` wird für Media erweitert:

- `image`
- `video`

Zu speichern:

- VM-ID
- Provider
- Capability
- Modell
- Status
- Usage-Status
- Queue-Zeit
- Provider-Latenz
- Gesamt-Latenz
- Anzahl Outputs
- Input-Bytes
- Output-Bytes
- Referenzanzahl
- Aspect Ratio
- Auflösung
- Videodauer
- Provider Request ID
- Provider Operation ID / Task ID
- Fehlermeldung und Fehlercode
- Token Usage, wenn Provider sie liefert
- Provider-spezifische Roh-Usage als JSON

Pricing sollte nicht nur Tokens kennen, sondern capability-spezifische Units:

- Image: `output_count`, optional `input_tokens`, `output_tokens`, `total_tokens`
- Video: `video_seconds`, `output_count`, optional `input_tokens`, `output_tokens`, `total_tokens`

Wenn Provider keine Token liefert, wird trotzdem ein Usage-Event mit bestmöglichen Units gespeichert.

## Notebook-Integration

Neue Notebook-Komponente:

```text
app/lib/integrations/managed-media-client.ts
```

Aufgaben:

- Managed-Service-Env lesen:
  - `CANVAS_MANAGED_SERVICES_ENABLED`
  - `CANVAS_CONTROL_PLANE_URL`
  - `CANVAS_INSTANCE_TOKEN`
  - `CANVAS_INSTANCE_ID`
- Media-Job in Control Plane erstellen.
- Status pollen.
- Outputs herunterladen.
- Provider-ähnliches Ergebnis zurückgeben.
- Fehler in user-freundliche Studio-Fehler übersetzen.

Bestehende Provider bleiben erhalten:

- Gemini Image Provider
- OpenAI Image Provider
- Veo Service
- Seedance/KIE Service

Sie erhalten nur eine zusätzliche Fallback-Entscheidung:

```text
local key vorhanden -> lokale Provider-Integration
local key fehlt + managed enabled -> Control Plane
local key fehlt + managed nicht verfügbar -> Fehler mit Settings-Link
```

## Studio-Kompatibilität

Bestehende Studio-Responses bleiben gleich.

Notebook schreibt weiterhin:

- `studio_generations`
- `studio_generation_outputs`
- lokale Output-Dateien im Studio-Workspace

Zusätzliche Output-Metadaten:

- `managedFallback: true`
- `controlPlaneJobId`
- `managedProvider`
- `managedCapability`
- `usage`
- `upstreamOperationId`
- `upstreamTaskId`

Die UI muss keinen neuen Provider kennen.

## Fehlerverhalten

Wenn der lokale Key fehlt und Managed Fallback nicht funktioniert, soll Studio einen klaren Fehler zeigen.

Beispiele:

- Control Plane nicht erreichbar.
- `CANVAS_INSTANCE_TOKEN` fehlt.
- Managed Secret in Control Plane fehlt.
- Token hat den notwendigen Scope nicht.
- Provider-Job ist fehlgeschlagen.

Fehlermeldung:

```text
Der lokale API-Key fehlt und der Managed Fallback über Canvas Control Plane ist nicht verfügbar. Bitte konfiguriere einen eigenen Key unter /settings?tab=integrations oder kontaktiere den Administrator.
```

Für provider-spezifische Fehler wird die Provider-Meldung kontrolliert gekürzt und in `studio_generations.metadata.error` gespeichert.

## Control-Plane Adapter

Die Control Plane bekommt eine interne Adapter-Schnittstelle:

```ts
interface ManagedMediaProviderAdapter {
  provider: string;
  capability: 'image' | 'video';
  start(job: ManagedMediaJob): Promise<ManagedMediaStartResult>;
  poll?(job: ManagedMediaJob): Promise<ManagedMediaPollResult>;
}
```

Image-Provider können meist synchron oder kurz laufend abgeschlossen werden.

Video-Provider sollten immer als start/poll-Flow implementiert werden, auch wenn ein Provider theoretisch blockierend antworten kann.

Adapter in Phase 1:

- `GeminiImageAdapter`
- `OpenAIImageAdapter`
- `GeminiVeoAdapter`
- `KieSeedanceAdapter`

## Observability

Logs und Metriken sollten folgende IDs enthalten:

- `jobId`
- `vmId`
- `provider`
- `capability`
- `model`
- `clientGenerationId`
- `upstreamOperationId`
- `upstreamTaskId`

Wichtige Metriken:

- Jobs queued/running/succeeded/failed
- durchschnittliche Queue-Zeit
- durchschnittliche Provider-Latenz
- Fehlerrate pro Provider
- nicht abgeholte Outputs
- abgelaufene Outputs

## Sicherheit

- Keine Provider-Secrets an Notebook zurückgeben.
- Control Plane nutzt Managed Provider Secrets aus bestehender Secret-Verwaltung.
- Alle Download-Endpoints erfordern gültiges VM Bearer Token.
- Job-Zugriff nur für die VM, die den Job erstellt hat.
- Temporäre Dateien liegen außerhalb öffentlicher Web-Verzeichnisse.
- Outputs werden nach `ack` oder Retention-Ablauf gelöscht.
- Logs enthalten keine Base64-Medien und keine vollständigen Secrets.

## Implementierungsreihenfolge

### 1. Control Plane Schema

- Tabellen für Media-Jobs und temporäre Outputs anlegen.
- Usage-Events für `image` und `video` vorbereiten.
- Pricing-Units für Media erweitern.

### 2. Control Plane API

- Generische Media-Endpunkte implementieren.
- VM Bearer Auth und Scope-Prüfung ergänzen.
- Multipart-Upload für Referenzen unterstützen.
- Output-Download und `ack` implementieren.

### 3. Control Plane Worker

- Postgres-Queue mit Lease-Locking implementieren.
- Worker-Loop für `queued` und `waiting_upstream` Jobs.
- Retry- und Timeout-Regeln ergänzen.
- Cleanup für temporäre Dateien ergänzen.

### 4. Provider-Adapter

- Gemini Image Adapter.
- OpenAI Image Adapter.
- Gemini Veo Adapter.
- KIE / Seedance Adapter.
- Usage-Extraktion je Provider.

### 5. Notebook Managed Media Client

- Env-Erkennung für Managed Mode.
- Job-Erstellung, Polling und Download.
- Einheitliche Fehlerbehandlung.

### 6. Notebook Provider-Fallbacks

- Gemini Image Provider erweitern.
- OpenAI Image Provider erweitern.
- Veo Service erweitern.
- Seedance/KIE Service erweitern.

### 7. Studio-Fehler und Metadaten

- Fehlermeldungen mit Link zu `/settings?tab=integrations`.
- Output-Metadaten um Managed-Fallback-Details ergänzen.
- Bestehende UI unverändert lassen.

### 8. Tests

- Unit/API-Tests für Control-Plane Auth, Queue und Adapter-Mocks.
- Notebook-Tests für lokale-Key-Priorität und Managed-Fallback.
- `npm run build` vor Container-Builds.
- UI/E2E mit Playwright nur nach expliziter Freigabe.

## Offene Detailentscheidungen

- Exakte Tabellenaufteilung: eine Job-Tabelle plus Output-Tabelle oder JSON Outputs im Job.
- Ob temporäre Dateien in Phase 1 lokal oder direkt in S3/R2 gespeichert werden.
- Konkrete Pricing-Modelle pro Provider und Modell.
- Ob vollständige Prompts standardmäßig gespeichert werden dürfen oder nur mit Opt-in.
- Maximalgrößen für Referenzbilder und Requests.

## Empfehlung

Start mit Postgres-Queue, generischer Media-API und temporärer lokaler Output-Ablage in der Control Plane. Das hält die erste Implementierung klein, robust und kompatibel mit der bestehenden Infrastruktur.

Redis oder objektbasierter Storage sollten erst ergänzt werden, wenn reale Last oder horizontale Skalierung es notwendig macht.
