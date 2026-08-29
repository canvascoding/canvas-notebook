---
title: 'Umsetzungsplan zu Ticket 28: Chat-Kontextkomprimierung und Session-Fortsetzung stabilisieren'
status: implementation_started
date: 2026-08-26
platforms: [server, agent-runtime, web]
tags: [type/implementation-plan, topic/agents, topic/chat, topic/context-window, topic/sessions]
---

# Umsetzungsplan: Chat-Kontextkomprimierung und Session-Fortsetzung stabilisieren

## Planungsstatus und Grenzen

Dieser Plan konkretisiert
[Ticket 28](./28-chat-kontextkomprimierung-und-session-fortsetzung-stabilisieren.md)
auf Basis des aktuellen Repository-Stands. Die Budgetanalyse, der
Budgetvertrag, das additive Persistenzfundament und der isolierte Coordinator
sowie seine Live-/Manual-Runtimeintegration sind technisch umgesetzt.
Auch die persistente Automation verwendet inzwischen den Coordinator;
der inhaltsfreie Runtime-/UI-Statusvertrag ist ebenfalls umgesetzt. Die
Gesamtabnahme ist weiterhin geplant. Das Ticket bleibt offen und ist nicht
abgenommen.

Der lokale Hermes-Checkout wurde ausschliesslich read-only als Referenz
gelesen. Browser, Dev-Server, Container und externe Systeme bleiben fuer die
ersten Implementierungsphasen ausgeschlossen.

### Implementierungsfortschritt 2026-08-27

Phase 1A und Phase 1B sind technisch umgesetzt:

- `app/lib/pi/context-budget.ts` definiert validierte Canvas-Policy,
  Output-Cap, immutable Snapshot, inhaltsfreie Fingerprints und
  providergebundene Kalibrierungsevidenz;
- `multimodal-preparation.ts` erzeugt finale Nachrichten und Snapshot an
  derselben Normalisierungsgrenze;
- Live-Runtime und persistente Automation senden den reservierten Cap
  tatsaechlich als `maxTokens`, lehnen einen final zu grossen Payload vor dem
  Provider ab und invalidieren Evidenz bei Prompt-/Tool-/Runtimeaenderungen;
- `history-budget.ts` selektiert Raw-History nur noch in atomaren
  ToolCall/Result-Einheiten;
- derselbe Planner wendet nun die injizierbare Canvas-Policy als
  Soft-Trigger, Target-Tail und Hardlimit an, entfernt reine UI-/Auth-Marker
  aus Budget und Modellpayload und schuetzt den aktuellen Nutzerturn samt
  nachfolgender Toolkette ungeteilt;
- eine vorhandene Summary wird nur bei fehlendem Raw-Praefix oder
  ueberschrittenem Soft-Trigger verwendet. Ihre Sequenzabdeckung und der
  rohe Tail sind disjunkt; `includedSummary` beschreibt nur eine tatsaechlich
  gesendete Summary;
- `preparePiHistoryContext()` liefert einen gemeinsamen `safeToSend`-Vertrag.
  Scheitert die Summary, darf Live, Manual oder Automation nur mit dem
  vollstaendigen Hardlimit-Fallback fortfahren; andernfalls wird vor dem
  Provider abgebrochen, ohne Originalnachrichten zu entfernen;
- fokussierte Contract-, Summary-, Automation-, Multimodal-, Vision-,
  Runtime-Prompt-, Effective-Tool-, Continuation- und Temperature-Tests,
  TypeScript, Lint und Produktionsbuild wurden ausgefuehrt.

Damit sind die Gates von Phase 1A und 1B technisch erfuellt. Phase 2, der
Coordinator aus Phase 3 und der produktive Live-/Manual-Adapter aus Phase 4
sowie der Automation-Adapter aus Phase 5 sind ebenfalls technisch umgesetzt;
ihr genauer Stand ist unten dokumentiert. Phase 6 ist technisch umgesetzt;
Phase 7 bleibt geplant.
Insbesondere wurden keine manuelle
Langchat-/UI-Abnahme, kein Browser-/Playwright-Test und keine externe
Providerkalibrierung ausgefuehrt; Ticket 28 bleibt offen.

Der spaetere Implementierungsgrundsatz lautet:

```text
Originalverlauf bleibt die wiederherstellbare Quelle.

Budget-Snapshot + persistierter Sequenz-Watermark
  -> privater, abbrechbarer Komprimierungsversuch
  -> Commit nur bei weiterhin gueltiger Session-/Summary-Revision
  -> atomare Summary- und Watermark-Persistierung
  -> kanonischer Modellkontext = Summary + nicht ueberlappender, gueltiger Tail

Fehler, Timeout, Abbruch oder Stale State
  -> kein Commit, keine Nachrichtenentfernung, kein spaetes Ergebnis
  -> begrenzter Retry und eindeutiger, inhaltsfreier Status
```

Eine Umsetzungsphase beginnt erst, wenn die vorherige Phase implementiert,
automatisiert geprueft und fokussiert committed ist. Browser-/Playwright-Tests
und manuelle Runtime-Pruefungen erfolgen gemaess Repository-Regeln erst nach
expliziter Freigabe.

## Analysierte Quellen

### Canvas Notebook

Die folgenden aktuellen Pfade bilden den relevanten Vertrag:

- `app/lib/pi/history-budget.ts`: Token-/Byte-Schaetzung, History-Budget,
  Summary-Einbettung, Suffixauswahl und Sequenzfilter;
- `app/lib/pi/session-summary.ts`: Summary-Prompt, Text-/Tool-Projektion,
  Batch-Aufrufe und Fortschreibung des Summary-Watermarks;
- `app/lib/pi/live-runtime.ts`: automatische Komprimierung in
  `transformContext()`, manuelles `compactNow()`, Runtime-Status,
  `compact-break` und inkrementelle Persistierung;
- `app/lib/pi/session-store.ts` sowie `app/lib/db/schema.ts` und
  `app/lib/db/migrate.ts`: Nachrichtenreihenfolge und Summary-Persistierung;
- `app/lib/pi/runtime-service.ts` und
  `app/lib/pi/session-operation-lock.ts`: Control-API und Session-Lock;
- `app/lib/pi/message-normalization.ts`,
  `app/lib/pi/multimodal-preparation.ts`,
  `app/lib/pi/message-projection.ts` und
  `app/lib/pi/llm-payload-limits.ts`: Providerprojektion, Bilder,
  Toolresultat-Projektion und Byte-Limits;
- `app/lib/automations/runner.ts`: zweiter produktiver Consumer von
  `preparePiHistoryContext()`;
- `app/components/canvas-agent-chat/CanvasAgentChat.tsx`,
  `useChatControlActions.ts`, `useChatRuntimeEvents.ts`,
  `useChatSessionMessages.ts`, `chatMessageMapping.ts` und
  `ChatMessageList.tsx`: Status, manuelles Compact und Break-Marker;
- `scripts/pi-session-summary-test.ts`, `scripts/pi-integration-test.mjs` und
  die Compact-Faelle in `tests/pi-chat.spec.ts`: vorhandene Testabdeckung.

Die Historie der bisherigen Schutzmassnahmen wurde ebenfalls geprueft,
insbesondere `Track PI summary progress by sequence`, `Harden agent context
budgeting and compaction`, `Budget summaries and automation context`,
`Fix first-message context budgeting`, die effektive Tool-/Prompt-Kopplung aus
Ticket 18 und die Vision-/Bildkorrekturen aus Ticket 26.

### Hermes-Referenz

Gelesen wurde der lokale Checkout
`/Users/frankalexanderweber/Documents/hermes-agent` auf Commit
`f293e7206b4ddd66042329442c6afebc19a8808d` (`main`, Stand 2026-08-14),
vor allem:

- `agent/context_compressor.py`;
- `agent/conversation_compression.py`;
- die Regressionstests fuer Commit-Fence, Watermark-Commit, Live-Tail-
  Erhaltung, Interrupt/Timeout, Persistenz, Session-Rebind sowie
  Cooldown-/Anti-Thrash-Zustand.

Uebertragbar sind die **Invarianten**, nicht die Implementierung:

- ein privater Snapshot pro Versuch;
- ein geschuetzter aktueller Tail und unteilbare Toolgruppen;
- genau ein aktiver Versuch pro Session;
- ein Commit-Fence gegen spaete Ergebnisse nach Timeout oder Abbruch;
- ein persistierter Watermark und ein atomarer, holder-/revisionsgepruefter
  Commit;
- inhaltsfreie Versuchstelemetrie, begrenzte Retries und Reset pro Session.

Nicht nach Canvas zu kopieren sind Hermes' Python-Thread-/Daemon-Executor,
Session-Rotation in Parent/Child-Sessions, gateway-spezifische Statusfilter,
der dortige Prompt-Cache-Vertrag, Micro-Compaction oder ein destruktiver
statischer Summary-Fallback. Canvas behaelt seine PI-Agent-, Workspace-,
Provider-, Daten- und UI-Architektur.

#### Konkretes Hermes-Budgetmodell und belastbare Uebertragung

Hermes ermittelt sein Komprimierungslimit nicht allein aus der sichtbaren
Chat-Historie. Der Referenzstand bildet zuerst ein effektives Eingabefenster
aus `context_length - max_tokens` (sofern positiv), schaetzt den gesamten
Request aus Systemprompt, Wire-/Nachrichtenform, Toolschemas und Bildern und
wendet darauf eine modellabhaengige Triggerpolicy an. Fuer kleinere Fenster
existieren feste Prozent-/Tokenfloors; ein separater Tail-Target-Wert bestimmt,
wie viel Rohhistorie nach einer Komprimierung verbleibt. Spaetere
Provider-Usage wird zusammen mit der vorherigen Schaetzung protokolliert und
kann die Schaetzqualitaet fuer denselben Requesttyp belegen.

Diese Details sind **Evidenz fuer das Design**, keine fuer Canvas gueltigen
Konstanten. Uebertragen werden:

- Ausgabe vor der Eingabebelegung reservieren und dabei denselben Cap
  verwenden, der tatsaechlich im Providerrequest steht;
- den kompletten finalen Request betrachten: effektive Anweisungen,
  serialisierte Nachrichten, effektive Tools, Runtime-/Provider-Envelope und
  multimodale Last;
- ToolCall/Result-Gruppen und die neueste echte Nutzer-/Tool-Einheit atomar
  behandeln;
- Trigger, Target und Safety als getrennte, kalibrierbare Policywerte fuehren;
- Provider-Usage nur zusammen mit Modell-, Prompt-, Tool- und
  Payloadidentitaet als nachtraegliche Kalibrierungsevidenz speichern.

Nicht uebertragen werden die Hermes-Floors und Prozentwerte (unter anderem
64k-, 75-/85-Prozent- und Lean-/Overshoot-Konstanten), grobe Bildpauschalen,
Session-Rotation, Recovery-Pointer, Gatewaystatus, Python-Threads,
Micro-Compaction, Prompt-Cache-Vertraege oder destruktive statische
Zusammenfassungen. Canvas darf daraus insbesondere keine universelle
Provider-Tokenformel ableiten.

#### Canvas-Budgetvertrag

Fuer einen eingefrorenen finalen Hauptmodell-Payload gelten konzeptionell:

```text
W = verifiziertes Kontextfenster des effektiven Modells
I = effektive System-/Developer-Anweisungen
T = final serialisierte effektive Toolschemas
R = Runtime-/Provider-Envelope und sonstige feste Requestfelder
O = tatsaechlich im Request gesendeter Output-Cap
S = explizite Safety-Reserve fuer Tokenizer-/Adapterunsicherheit
H = max(0, W - I - T - R - O - S)       // hartes History-Budget
trigger = floor(H * triggerRatio)         // Start der Komprimierung
target  = floor(H * targetRatio)          // Ziel fuer Summary + Raw-Tail
```

Die Nachrichtenschaetzung `M` wird auf dem nach Providerprojektion und
Multimodalnormalisierung final serialisierbaren Nachrichtensatz gebildet und
gegen `H`, `trigger` und `target` verglichen. Byte- und Bildgrenzen bleiben
zusaetzliche harte Achsen; sie werden nicht in scheinbar exakte Tokens
umgerechnet. `targetRatio < triggerRatio <= 1` ist eine validierte Policy,
nicht hart an Hermes gekoppelt.

Der Snapshot ist unveraenderlich und inhaltsfrei diagnostizierbar. Er traegt
Fingerprints/Revisionen fuer Modell samt Limitmetadaten, effektive
Anweisungen, effektive Tools, Runtime-Enveloperegeln,
Multimodalnormalisierung und finalen Payload. Eine Aenderung an einer dieser
Grenzen erzeugt einen neuen Snapshot; ein laufender Versuch wird nicht
nachtraeglich umgedeutet.

Provider-Usage wird als separates Kalibrierungsdatum mit expliziter
Konfidenz behandelt, beispielsweise `heuristic`, `provider_reported` oder
`verified_same_contract`. Sie darf einen Snapshot nur fuer denselben
Fingerprint plausibilisieren. Ob ein Provider Toolschemas, Cache-Tokens,
Systemrollen, Bilder oder interne Adapter-Overheads in `input_tokens`
einschliesst, ist providerspezifisch und bis zum verifizierten Contract als
Unsicherheit mit Safety-Reserve zu behandeln.

## Heutiger Daten- und Kontrollfluss

### Automatischer Live-Turn

1. `runtime-service.ts` serialisiert das Starten des Turns mit
   `withPiSessionOperationLock()` und ruft `LivePiRuntime.startPrompt()` auf.
   Der Lock endet, sobald der asynchrone Agentlauf gestartet ist.
2. PI Agent Core fuegt die Nutzeranfrage in den In-Memory-Verlauf ein und ruft
   `transformContext(messages, signal)` auf.
3. `live-runtime.ts` baut den aktuellen Runtime-Kontext und ruft
   `preparePiHistoryContext()` auf.
4. `history-budget.ts` zieht Systemprompt, Outputreserve, Toolschemas,
   Runtime-Kontext und Sicherheitsreserve vom Modellfenster ab. Anschliessend
   wird rueckwaerts ein Nachrichtensuffix aufgebaut, bis Token- oder
   8-MB-History-Limit erreicht sind.
5. Sind alte Nachrichten ausgelassen, filtert `session-summary.ts` anhand von
   `summaryThroughSequence` beziehungsweise Timestamp die noch nicht
   zusammengefassten Nachrichten und ruft ueber denselben scoping-sicheren
   `streamFn` das Summary-Modell auf.
6. Das Ergebnis wird bereits in `transformContext()` in `this.summary`
   uebernommen. `recordCompaction()` emittiert Erfolg und haengt einen
   `compact-break` an `agent.state.messages`.
7. Erst danach wird der komponierte Kontext an das Hauptmodell gesendet.
8. Bei `turn_end`, `agent_end` oder einem Agentfehler persistiert
   `persistMessages()` neue Nachrichten und den gerade im Speicher liegenden
   Summary-Zustand.

### Manuelles Compact

1. Web-UI oder Kanalbefehl senden `control(..., 'compact')`.
2. `runtime-service.ts` haelt den allgemeinen Session-Operation-Lock waehrend
   des gesamten externen Summary-Aufrufs.
3. `compactNow()` weist laufende Agentturns ab, erzeugt die Summary, mutiert
   bei Erfolg In-Memory-Summary und Break-Marker und ruft danach
   `savePiSession()` auf.
4. Die UI interpretiert den zurueckgegebenen Runtime-Status als Erfolg oder
   zeigt einen generischen Systemfehler.

### Reload und Fortsetzung

1. `loadPiSessionWithSummary()` laedt Summary-Felder aus `pi_sessions` und
   Nachrichten sortiert nach `sequence`, dann `id`.
2. Geladene Nachrichten erhalten ihre persistierte Sequenz. Grosse
   Toolresultate und Inline-Bilder werden fuer den Runtime-Kontext projiziert;
   die rohen DB-Daten bleiben bestehen.
3. Eine neue Runtime setzt `lastPersistedLength` auf die geladene
   Nachrichtenanzahl und verwendet Summary und Nachrichten wieder in
   `composePiHistoryForLlm()`.

### Automation

`app/lib/automations/runner.ts` ruft denselben Summary-/Budget-Helfer auf,
persistiert die aktuelle Nutzeranfrage vor dem Agentloop und speichert Summary
und Endverlauf bei Erfolg, No-op oder Fehler. Die Budgetmechanik wird geteilt,
der Commit- und Statusvertrag derzeit nicht.

## Beobachtete Fehlerbilder und Ursachen

Die folgenden Befunde sind direkt aus dem aktuellen Code ableitbar. Die
spaetere Phase 0 muss sie mit deterministischen Fixtures reproduzieren, bevor
Produktlogik veraendert wird.

### F1: Fehlgeschlagene automatische Summary kann Kontext still verlieren

`preparePiHistoryContext()` liefert bei leerem, abgebrochenem oder
fehlerhaftem Summary-Ergebnis `summaryFailed=true`, behaelt aber die bereits
auf das Suffix gekuerzte `composition`. `compactNow()` und die Automation
weisen diesen Zustand ab, `LivePiRuntime.transformContext()` dagegen nicht.
Dadurch kann der Hauptmodellaufruf mit dem neuen Tail **ohne** die ausgelassene
Historie und **ohne** neue Summary fortfahren. Der Originalverlauf bleibt zwar
gespeichert, der konkrete Modellturn verliert aber Arbeitskontext. Beim
naechsten Turn wird derselbe Summary-Aufruf erneut versucht; ein Cooldown oder
Versuchslimit existiert nicht.

### F2: Sequenz-Watermark driftet innerhalb einer lange lebenden Runtime

Geladene Nachrichten besitzen `sequence`; nachfolgend gespeicherte
In-Memory-Nachrichten werden von `savePiSession()` jedoch nicht mit den neu
vergebenen DB-Sequenzen aktualisiert. Fasst eine spaetere Komprimierung solche
Nachrichten zusammen, kann `summaryThroughTimestamp` voranschreiten, waehrend
`summaryThroughSequence` auf der letzten geladenen Sequenz stehen bleibt.
Nach Reload tragen dieselben Nachrichten nun DB-Sequenzen groesser als der alte
Watermark. `getUnsummarizedMessages()` priorisiert bei vorhandener
`summaryThroughSequence` die Sequenz und ignoriert fuer diese Nachrichten den
Timestamp. Bereits zusammengefasster Inhalt kann dadurch erneut in die Summary
einfliessen.

### F3: Ergebnisuebernahme besitzt keinen Commit-Fence

Summary-Text, Runtime-Summary und Break-Marker werden direkt nach dem
Providerergebnis in den Live-State uebernommen. Es gibt keine Attempt-ID,
Summary-Revision oder erneute Pruefung, ob Signal, Runtime-Generation,
Session-Scope und Nachrichten-Watermark noch dem gestarteten Versuch
entsprechen. Ein Timeout existiert nicht; ein Provider, der Abbruchsignale
verspaetet verarbeitet, kann nach Session-Invalidierung oder Abbruch spaet
zurueckkehren. `dispose()` loest keinen separaten Summary-Versuch auf.

### F4: Persistierung und In-Memory-Uebernahme sind nicht gemeinsam atomar

Beim manuellen Pfad werden Summary und Marker vor `savePiSession()` mutiert.
Scheitert die DB-Operation, meldet die UI einen Fehler, waehrend die Runtime
bereits den neuen Zustand traegt. `savePiSession()` aktualisiert die
Sessionzeile, aktualisiert den Channel-Link und loescht beziehungsweise
schreibt Nachrichten in getrennten DB-Operationen ohne gemeinsame
Transaktion. Fuer Summary und Watermark fehlt zudem eine Compare-and-swap-
Revision. Das vorhandene prozesslokale Lock verhindert nicht alle
prozessuebergreifenden oder spaeten Writes.

### F5: Auto-Ausloesung beginnt erst an der Suffix-Abschneidegrenze

Es existiert kein eigener Soft-Trigger. Eine Summary wird erst versucht, wenn
`composePiHistoryForLlm()` mindestens eine Nachricht nicht mehr in das harte
History-Budget aufnehmen kann. Ungenauigkeiten der Schaetzung, spaet
hinzugefuegte Providerprojektionen oder ein wachsender Runtime-Kontext lassen
wenig Erholungsraum. `aggressive` existiert als Faktor, ist aber kein
kanonischer Trigger-/Target-Vertrag und wird in den produktiven Pfaden nicht
als solcher eingesetzt.

### F6: Status, manuelles Compact und echter Turn verwenden nicht denselben
Budget-Snapshot

`transformContext()` budgetiert den vollstaendig fuer den konkreten Turn
gebauten Runtime-Kontext. `getStatus()` und `compactNow()` beruecksichtigen
dagegen nur die Browser-Kontext-Schaetzung. Page-, Notebook-, Studio-, E-Mail-,
Workspace-, Channel-, Zeit-, aktive Datei- und Pluginbloecke koennen dadurch
im angezeigten/manuellen Budget fehlen. Der inaktive Statuspfad baut wiederum
nur den Browserblock. Ein Wert wie `contextUsagePercent` beschreibt daher
nicht verlaesslich dieselbe Anfrage, die spaeter an den Provider geht.

### F7: Der Suffixschnitt kennt keine Tool-Transaktionsgruppen

`composePiHistoryForLlm()` nimmt einzelne Nachrichten rueckwaerts auf. Es gibt
keine Ausrichtung auf `assistant`-ToolCalls und zugehoerige `toolResult`-
Nachrichten. Ein Schnitt kann deshalb ein Toolresultat ohne den ausloesenden
Call oder einen Call ohne alle Resultate behalten. Weder
`message-normalization.ts` noch die vorhandenen Ticket-28-Tests reparieren oder
weisen diesen Zustand explizit ab. Providerkonformitaet haengt damit von
spaeterem, nicht dokumentiertem Bibliotheksverhalten ab.

### F8: Summary und Rohhistorie koennen sich ueberlappen

`shouldIncludeSummary` wird unter anderem durch irgendeinen
`compact-break` im Verlauf aktiviert. Die Rohnachrichten werden bei
erfolgreicher Komprimierung nicht entfernt. Nach Wechsel auf ein groesseres
Kontextfenster kann der gesamte Rohverlauf wieder passen und trotzdem die
Summary zusaetzlich eingefuegt werden. Auch bei teilweisem Suffix kann der
Tail Nachrichten mit Sequenz kleiner/gleich `summaryThroughSequence`
enthalten. Damit sieht das Modell Fakten oder alte Nutzeranweisungen sowohl in
komprimierter als auch roher Form. Ausserdem meldet `includedSummary` aktuell
den urspruenglichen Wunschwert, selbst wenn die Summary spaeter aus
Budgetgruenden verworfen wurde.

### F9: Manueller Lauf ist nicht abbrechbar und bleibt als `idle` sichtbar

Der Control-Lock umschliesst den externen Summary-Aufruf. Ein spaeterer
`abort`-Control muss auf denselben Lock warten. `isRunning` und die normale
Runtime-Phase werden fuer `compactNow()` nicht gesetzt; Nutzer sehen keinen
verbindlichen `compacting`-Zustand und koennen nicht sicher unterscheiden, ob
der Aufruf laeuft, haengt, ein No-op war oder fehlgeschlagen ist.

### F10: Bild-/Attachment-Budget wird an zwei Grenzen berechnet

History-Budgetierung bewertet die noch nicht final normalisierten
`AgentMessage`s. `prepareMessagesForEffectiveModel()` kann danach Bilder aus
autorisierten Referenzen laden/komprimieren und setzt das separate
`MAX_LLM_TOTAL_IMAGE_BYTES`-Limit durch. Der History-Estimator kennt zwar
Einzelbild- und 8-MB-Grenzen, aber nicht notwendigerweise den finalen
providerfertigen Payload. Direktes Bild, Read-Tool-Bild und nach Reload bereits
projiziertes Bild koennen daher unterschiedliche Budgetevidenz liefern.

### F11: Versuchszustand und Ergebnisgruende sind nicht reloadfaehig

`lastCompactionKind` wird nach Runtime-Neuanlage aus jedem vorhandenen
`summaryUpdatedAt` als `automatic` abgeleitet; der echte Trigger und der
Omitted-Count gehen verloren. Fehlerzaehler, Retry-Zeitpunkt und Grund sind
nicht persistiert. Marker und Live-Events koennen Erfolg anzeigen, aber es
gibt keinen maschinenlesbaren Vertrag fuer `running`, `no_op`, `deferred`,
`failed`, `aborted` oder `stale`.

## Vor Umsetzung gezielt zu bestaetigen

Diese Punkte sind keine gesicherten Ursachen und duerfen nicht als Annahmen in
Produktcode einfliessen:

- die genaue Aufrufreihenfolge und Parallelitaetsgarantie von
  `transformContext` und `convertToLlm` in
  `@earendil-works/pi-agent-core@0.84.1`;
- ob einzelne Provideradapter Toolpaare bereits still reparieren und ob diese
  Reparatur ueber alle konfigurierbaren APIs gleich ist;
- welche Provider einen verlaesslichen Tokenzaehler oder nur grobe
  `contextWindow`-Metadaten anbieten;
- ob produktive Sessions bereits Summary-Zeilen ohne
  `summaryThroughSequence`, doppelte Sequenzen oder andere Legacyformen
  enthalten;
- ob ein kompakter automatischer Status im Chat oder nur in der Composer-
  Statuszeile gewuenscht ist. Der Plan sieht keine Inhaltsanzeige vor;
- ob Ephemeral Delegations in Ticket 28 aufgenommen werden sollen. Managed
  Delegations laufen bereits ueber `LivePiRuntime`; ein einturniger ephemeral
  Worker nutzt dagegen `agentLoop()` ohne den Live-Transform- und
  Summaryvertrag.

## Zielarchitektur und Entscheidungen

### A1: Ein kanonischer, unveraenderlicher Budget-Snapshot

Alle Pfade verwenden eine gemeinsame Struktur, beispielsweise in
`app/lib/pi/context-budget.ts` (oder als klar abgegrenzten Umbau von
`history-budget.ts`):

```ts
type PiContextBudgetSnapshot = {
  snapshotVersion: number;
  modelIdentity: string;
  modelFingerprint: string;
  instructionFingerprint: string;
  toolSchemaFingerprint: string;
  runtimeFingerprint: string;
  payloadFingerprint: string;
  contextWindowTokens: number;
  effectiveInstructionTokens: number;
  serializedMessageTokens: number;
  toolSchemaTokens: number;
  runtimeProviderOverheadTokens: number;
  multimodalTokens: number;
  serializedMessageBytes: number;
  multimodalBytes: number;
  outputReserveTokens: number;
  safetyReserveTokens: number;
  hardHistoryTokens: number;
  triggerHistoryTokens: number;
  targetTailTokens: number;
  hardHistoryBytes: number;
  totalImageBytesLimit: number;
  estimateConfidence: 'heuristic' | 'provider_reported' | 'verified_same_contract';
};
```

Der Snapshot wird aus dem **effektiven** Systemprompt, den **effektiven**
Toolschemas aus Ticket 18, dem fuer diesen Turn eingefrorenen Runtime-Kontext,
dem effektiven Modell sowie den final normalisierten und serialisierbaren
Nachrichten/Attachment-Metadaten abgeleitet. Der Builder erhaelt den
`outputReserveTokens`-Wert nicht aus einer zweiten Formel, sondern aus der
Requestoption, die derselbe Aufruf als `maxTokens` an `streamFn` sendet.
Status, manuell, automatisch und Automation erhalten denselben Builder. Ein
Status ohne konkreten Turn muss klar als Schaetzung markiert sein und darf
nicht vorgeben, einen noch nicht gebauten Page-/Plugin-Kontext zu kennen.

Es gelten drei getrennte Grenzen:

1. `hardHistoryTokens`: unter Einbezug aller festen Reserven darf die
   Provideranfrage diese Grenze nie planmaessig ueberschreiten;
2. `triggerHistoryTokens`: die automatische Komprimierung startet mit
   Sicherheitsabstand vor der harten Grenze;
3. `targetTailTokens`: nach Erfolg bleibt genug Luft fuer Summary, den
   aktuellen Turn und mindestens einen nuetzlichen Folgeturn.

Als initiale Canvas-Defaultpolicy werden 80 Prozent des harten
History-Budgets als Soft-Trigger und 60 Prozent als Tail-Ziel vorgeschlagen.
Die Werte liegen in einer injizierbaren, validierten Policy und sind **keine
Providerwahrheit oder Hermes-Konstanten**. Kalibrierungsfixtures pruefen sie
mit kleinen, mittleren und grossen Modellfenstern sowie realistischen
Toolschemas. Feste Minimalreserven duerfen ein kleines Modell nicht komplett
blockieren; eine dynamische Untergrenze wird explizit getestet.

Die bestehende Schaetzung `ceil(characters * 0.25)` bleibt als klar markierte
heuristische Baseline. Die Final-Payload-Evidenz zaehlt zusaetzlich
Serialisierungs-Envelope, Runtime-/Provider-Overhead, Bildtokens und Bytes als
getrennte Anteile; System-/Developerrollen und Tools werden nie aus der
Historyzahl abgeleitet. Provider-Usage kann nach einem Request nur als
fingerprintgebundene Kalibrierung mit expliziter Konfidenz hinzukommen. Wenn
PI AI einen API-spezifischen Zaehler bereitstellt, wird er hinter derselben
Schnittstelle genutzt; andernfalls schuetzen Soft-Trigger, Safety-Reserve und
ein einmaliger klassifizierter Overflow-Recovery-Pfad gegen Unterzaehlung.

### A2: Der Planner arbeitet mit unteilbaren Nachrichteneinheiten

Vor der Budgetauswahl werden Nachrichten in `PiHistoryUnit[]` gruppiert:

- ein normaler User-/Assistant-Turn als einzelne Einheit;
- eine Assistant-Nachricht mit ToolCalls plus alle zugehoerigen
  `toolResult`-Nachrichten als unteilbare Toolgruppe;
- ein noch laufender ToolCall bleibt vollstaendig im geschuetzten Tail oder
  blockiert die Komprimierung als `active_tool_chain`;
- interne `compact-break`-, Composio-Auth- und sonstige nicht an das LLM
  uebertragene Marker belegen kein History-Budget und entscheiden nicht ueber
  Summary-Inklusion;
- Runtime-Continuation-Nachrichten werden nach ihrem bestehenden
  Continuation-Vertrag gruppiert und nicht als neue Nutzerintention
  zusammengefasst.

Der getrennt uebergebene Systemprompt ist der geschuetzte Kopf. Es wird **kein
permanenter roher Chat-Kopf** eingefuehrt: Canvas speichert aktive Aufgabe,
Entscheidungen und Constraints strukturiert in der Summary; ein ewig
geschuetzter erster Userturn wuerde bei wiederholter Komprimierung
fossilisieren. Der geschuetzte Tail enthaelt mindestens die neueste echte
Nutzeranfrage und alle Nachrichten danach, plus rueckwaerts ganze Einheiten bis
zum Zielbudget. Passt allein diese geschuetzte Einheit nicht, wird vor dem
Summary-Aufruf der nicht-destruktive Fehler `latest_unit_too_large` geliefert.

Nach der Auswahl validiert eine pure Contract-Funktion:

- monotone Sequenzen;
- keine halben Toolgruppen oder orphaned IDs;
- neueste Nutzeranfrage exakt einmal;
- keine Marker im Providerpayload;
- Summary und Roh-Tail ueberlappen nicht;
- Token- und Byte-Hardlimit werden eingehalten.

### A3: Summary-Watermark ist ausschliesslich eine persistierte Sequenz

Neue Summary-Commits duerfen nur Nachrichten mit tatsaechlich persistierter
`sequence` abdecken. Timestamp bleibt Anzeige- und Legacyinformation, aber
nicht mehr die primaere Fortschrittsgrenze.

`savePiSession()` beziehungsweise ein fokussierter Append-Helper gibt deshalb
nach erfolgreicher DB-Transaktion einen Checkpoint mit den vergebenen
Sequenzen zurueck. `LivePiRuntime` stempelt exakt die gespeicherten
In-Memory-Nachrichten erst danach. Ein Summary-Kandidat traegt:

```ts
type PiSummaryCandidate = {
  attemptId: string;
  baseSummaryRevision: number;
  previousThroughSequence: number | null;
  throughSequence: number;
  coveredSequenceFingerprint: string;
  summaryText: string;
  budget: PiContextBudgetSnapshot;
};
```

Unpersistierte Nachrichten bleiben im Tail. Wuerde eine unpersistierte
Nachricht in den komprimierbaren Mittelteil fallen, wird vorerst nicht
zusammengefasst: der Turn persistiert sie zuerst kontrolliert oder liefert
`history_not_durable`. Ein heuristisches Fortschreiben anhand der Arrayposition
ist nicht erlaubt.

### A4: Summary und Raw-Tail bilden eine disjunkte Fortsetzung

Sobald eine gueltige Summary mit `summaryThroughSequence=N` verwendet wird,
enthaelt der rohe Modell-Tail nur Nachrichten mit Sequenz `> N` sowie den
aktuellen unpersistierten Tail. Nachrichten `<= N` werden nie zusaetzlich zur
Summary eingespeist. Passt bei einem groesseren Modell der vollstaendige
Rohverlauf und wird er bewusst ohne Summary verwendet, wird die Summary
komplett weggelassen. Mischformen mit Ueberlappung sind ungueltig.

Die tatsaechliche Inklusion wird aus dem fertigen Payload abgeleitet;
`includedSummary=true` darf nur gelten, wenn die Summary-Nachricht wirklich
vorhanden ist. `compact-break` bleibt reine Darstellung und darf keine
History-Entscheidung beeinflussen.

Die Originalnachrichten bleiben in dieser Stabilisierung unangetastet in
`pi_messages`. Eine physische Archivierung oder Loeschung erfolgreicher
Komprimierungsbereiche ist kein Bestandteil von Ticket 28. Damit bleiben
UI-Historie, Audit, Rollback und eine spaetere kontrollierte Rekonstruktion
moeglich.

### A5: Ein Compaction Coordinator serialisiert und fenced Versuche

Eine fokussierte Runtime-Komponente, beispielsweise
`app/lib/pi/session-compaction.ts`, verwaltet pro `(userId, sessionId,
agentId)` genau einen aktiven Versuch:

```ts
type PiCompactionState =
  | { state: 'idle' }
  | { state: 'running'; attemptId: string; trigger: 'automatic' | 'manual' | 'automation' }
  | { state: 'succeeded'; attemptId: string; committedThroughSequence: number }
  | { state: 'no_op'; attemptId: string; reasonCode: string }
  | { state: 'deferred'; attemptId: string; reasonCode: string; retryAfter: string | null }
  | { state: 'failed' | 'aborted' | 'stale'; attemptId: string; reasonCode: string };
```

Der Coordinator:

1. registriert Attempt-ID, Snapshot, Runtime-Generation und eigenen
   `AbortController`;
2. serialisiert manuell und automatisch; ein zweiter Aufruf erhaelt den
   vorhandenen `running`-Status statt eines zweiten Providercalls;
3. kombiniert Agent-, User-Abort-, Timeout- und Runtime-Dispose-Signal;
4. erzeugt die Summary nur auf einem privaten, sanitisierten Snapshot;
5. prueft unmittelbar vor Commit: Signal aktiv, Runtime nicht disposed,
   Attempt weiterhin aktuell, Scope unveraendert, Summary-Revision gleich,
   Watermark/Fingerprint gueltig;
6. uebernimmt erst **nach** erfolgreichem DB-Commit Summary und Erfolgsstatus
   in die Runtime;
7. verwirft jedes spaete Ergebnis. Der spaete Promise-Pfad wird sauber
   konsumiert, darf aber weder DB, Runtime, Marker, Cooldown noch UI aendern.

Ein Summary-Timeout wird als eigener inaktiver/gesamter Grenzwert gekapselt,
ohne zunaechst neue nutzerkonfigurierbare Optionen einzufuehren. Der genaue
Wert wird in Phase 0 gegen die vorhandenen Provider-Timeouts festgelegt. Ein
Providerstream mit Fortschritt darf nicht wie ein stiller Hang behandelt
werden, sofern die PI-Stream-Schnittstelle einen sicheren Progress-Hook
anbietet. Fehlt dieser Hook, gilt ein dokumentierter Gesamt-Timeout und der
Commit-Fence bleibt die Sicherheitsgrenze.

### A6: Persistenter Versuch und atomarer Summary-Commit

Die bevorzugte Datenloesung ist eine additive, inhaltsfreie
`pi_session_compaction_attempts`-Tabelle plus `summary_revision` in
`pi_sessions`.

Versuchsmetadaten enthalten nur:

- Attempt-ID, Session-FK, Trigger und Zustand;
- Basis-/Commit-Summary-Revision und Through-Sequence;
- Start-, Deadline-, Abschluss- und Retry-Zeitpunkt;
- Grundcode, Dauer, Modell-/Provider-ID;
- vorher/nachher Token-/Byte-Schaetzung sowie Anzahl geschuetzter,
  zusammengefasster und ausgelassener Einheiten;
- **keinen** Summary-Text, Prompt, Nachrichtentext, Toolargumente, Pfad,
  Anhang, Data-URL oder Credentialwert.

Start und Abschluss laufen ueber eine eigene DB-Transaktion. Der Erfolgscommit
aktualisiert in derselben Transaktion:

1. `pi_sessions.summary_text`, `summary_updated_at`,
   `summary_through_timestamp` (nur kompatibel) und
   `summary_through_sequence`;
2. `summary_revision = summary_revision + 1` mit Compare-and-swap auf
   `baseSummaryRevision` und den alten Watermark;
3. den Versuch von `running` auf `succeeded` samt Metriken.

Die Transaktion prueft serverseitig User-, Agent- und Session-Scope sowie,
dass `throughSequence` existiert und nicht hinter/vor einer widerspruechlichen
Summary-Grenze liegt. Parallele neue Nachrichten oberhalb des Watermarks
duerfen bestehen bleiben; sie werden nicht als vom Kandidaten abgedeckt
behauptet. Ein konkurrierender Summary-Commit laesst den CAS verlieren und
liefert `stale`, nie Last-Writer-Wins.

SQLite und PostgreSQL erhalten denselben Vertrag. Eine pro Session eindeutige
aktive Attempt-Zeile oder ein gleichwertiger transaktionaler Start-CAS schuetzt
auch zwischen Prozessen. Abgelaufene `running`-Versuche werden beim naechsten
Zugriff in `timed_out` ueberfuehrt; kein globaler Hintergrundjob ist dafuer
erforderlich.

`savePiSession()` darf nach Einfuehrung dieses Vertrags keine neuere Summary
mit einem stale In-Memory-Snapshot ueberschreiben. Summary-Schreibrechte werden
aus dem allgemeinen Nachrichten-Save herausgezogen oder erfordern explizit die
erwartete `summaryRevision`. Automation und No-op-Finalisierung werden auf
denselben Commit-Helper umgestellt.

### A7: Summary-Erzeugung bleibt untrusted, bounded und inhaltsfrei beobachtet

Die bestehende Summary-Struktur wird beibehalten und geschaerft:

- `Active Task`;
- `Decisions And Constraints`;
- `Files And Artifacts`;
- `Relevant Tool Results`;
- `Completed Work`;
- `Open Questions And Blockers`;
- `Next Safe Step`.

Prior Summary und Conversation Records bleiben markierte untrusted Daten.
Die neue Summary darf keine enthaltenen Anweisungen als System-/Useranweisung
ausgeben. Thinking, Bilder, Data-URLs, serverinterne absolute Pfade und
unbegrenzte Toolresultate bleiben ausgeschlossen. Vor Persistierung wird ein
gemeinsamer, getesteter Redaktionshelper fuer offensichtliche Credentials und
Env-Assignments angewendet; er darf keine echten Secretwerte aus dem
Integrationsspeicher laden. Summary-Inhalt wird nie in UI, Logs,
Versuchsmetadaten oder Telemetrie ausgegeben.

Ein leeres, abgebrochenes, zu langes oder formal unbrauchbares Ergebnis ist
kein Erfolg. In Ticket 28 wird standardmaessig **kein** lokal erzeugter
destruktiver Fallback als Ersatzsummary committed. Ist Komprimierung nur wegen
des Soft-Triggers ratsam und passt der vollstaendige disjunkte Rohkontext noch
unter das Hardlimit, darf der aktuelle Turn einmal unverkuerzt fortfahren und
der Versuch wird `deferred`. Ist Komprimierung fuer das Hardlimit erforderlich,
wird der Hauptmodellaufruf nicht mit still ausgelassener Historie gestartet.

### A8: Begrenzte Retry- und Overflow-Semantik

Pro Agentturn gibt es hoechstens einen automatischen Summary-Versuch und
hoechstens einen klassifizierten Recovery-Versuch nach einem echten
Provider-Context-Overflow. Kein generischer Fehler darf diese Recovery
ausloesen.

Automatische Fehler verwenden einen exponentiell begrenzten, persistierten
Cooldown, beispielsweise 30 Sekunden, 2 Minuten und 10 Minuten; die genauen
Werte werden in Phase 0 festgelegt. Ein erfolgreicher Commit setzt den Zaehler
zurueck. Ein manueller Versuch darf den Auto-Cooldown bewusst einmal umgehen,
ist aber weiterhin serialisiert, abbrechbar und nicht rekursiv. Sessionwechsel,
Loeschung und Runtime-Dispose entfernen nur den In-Memory-Zustand dieser
Session; persistierte Fehler anderer Sessions werden nie uebernommen.

Stabile Grundcodes:

- `soft_threshold_not_reached`;
- `nothing_eligible`;
- `latest_unit_too_large`;
- `fixed_context_too_large`;
- `active_tool_chain`;
- `history_not_durable`;
- `summary_provider_error`;
- `summary_timeout`;
- `aborted`;
- `stale_snapshot`;
- `persistence_conflict`;
- `cooldown_active`;
- `provider_context_overflow`;
- `payload_bytes_exceeded`.

Interne Providerfehler werden klassifiziert, aber nur ein sicherer,
redigierter Handlungsgrund erreicht die UI.

### A9: Manuell und automatisch teilen denselben Vertrag

`compactNow()` wird kein separater Summary-/Save-Pfad mehr. Manuell,
automatisch und Automation rufen denselben Planner, Summary-Generator,
Coordinator und Commit-Helper auf. Unterschiede bestehen nur in Trigger,
Cooldown-Regel und UI-Ausloesung.

Der allgemeine Session-Operation-Lock darf nicht waehrend des gesamten
externen Summary-Aufrufs gehalten werden. Er registriert beziehungsweise
findet den Runtimeversuch; die lange Arbeit laeuft unter dem spezialisierten
Compaction-Lease. `abort` muss den aktiven Agentturn und/oder Summaryversuch
erreichen koennen, ohne hinter dessen Startlock zu warten. Sessionstart,
Modellwechsel und exklusive Automation muessen den aktiven Versuch entweder
kontrolliert abwarten oder abbrechen und dessen Commit invalidieren.

### A10: Expliziter UI- und Eventvertrag

`PiRuntimeStatus` erhaelt einen verschachtelten inhaltsfreien
`compactionStatus` statt weiterer lose abgeleiteter Felder. Der vorhandene
`context_compacted`-Erfolgsevent bleibt fuer Kompatibilitaet, wird aber erst
nach DB-Commit emittiert und traegt eine Attempt-ID. Ein neuer
`context_compaction_status`-Event transportiert `running`, `no_op`,
`deferred`, `failed`, `aborted`, `stale` und `succeeded` mit Grundcode und
gegebenenfalls `retryAfter`.

Die Web-UI zeigt ruhig und ohne Summary-Inhalt:

- „Kontext wird zusammengefasst …“ mit abbrechbarem Zustand;
- Erfolg mit Anzahl der zusammengefassten Einheiten;
- „bereits optimiert“ fuer No-op;
- „aktuelle Nachricht/Anhaenge sind zu gross“ mit Kuerzen/Modellwechsel als
  naechster Aktion;
- „Zusammenfassung derzeit nicht verfuegbar“ mit Retry-Zeitpunkt;
- einen klaren allgemeinen Fehler fuer Persistenzkonflikt, ohne Retryloop.

Break-Marker werden anhand Attempt-ID dedupliziert. Sie bleiben
Darstellungsmetadaten und werden erst nach Commit erzeugt. Fuer Reload muss der
persistierte Versuchszustand die korrekte Art und Zeit liefern; ein beliebiges
`summaryUpdatedAt` darf nicht pauschal als automatische Komprimierung gelten.
Wie ein Marker positionsgenau in eine paginierte Historie gemischt wird, wird
in Phase 6 festgelegt. Eine separate Attempt-Liste ist dabei verlaesslicher als
den Marker als LLM-Nachricht zu behandeln.

### A11: Bild-/Attachment-Vertrag wird vor der finalen Budgetentscheidung
eingefroren

Ticket 26 bleibt autoritativ fuer Berechtigung, MIME, Komprimierung und
optimistischen Vision-Fallback. Ticket 28 fuehrt keine zweite
Bildnormalisierung ein. Stattdessen liefert die bestehende
Provider-Vorbereitung eine inhaltsfreie Payload-Evidenz (Anzahl und
komprimierte Byte-Schaetzung), die der Budget-Snapshot verwendet.

Der neueste Bild-/Attachment-Turn bleibt geschuetzt. Historische Bildbytes
werden nicht in die Summary geschickt; kontrollierte Platzhalter und relevante
textuelle Toolergebnisse koennen zusammengefasst werden. Ein Bild, das allein
das Total-Image- oder History-Byte-Limit ueberschreitet, erzeugt vor dem
Summary-Aufruf `payload_bytes_exceeded` und keine Nachricht wird entfernt.

## Vorgeschlagene Dateigrenzen

Die genaue Benennung kann in der Umsetzung angepasst werden; die
Verantwortlichkeiten duerfen nicht wieder in einen monolithischen Helper
fallen.

| Bereich | Voraussichtliche Dateien | Verantwortung |
| --- | --- | --- |
| Budget/Planner | `app/lib/pi/context-budget.ts`, `history-budget.ts` | ein Snapshot, atomare Units, Trigger/Target/Hardlimit, disjunkte Komposition |
| Summary | `app/lib/pi/session-summary.ts` | sanitisiertes Input, Batching, strukturierte Candidate-Erzeugung, keine Persistierung |
| Coordinator | neu `app/lib/pi/session-compaction.ts` | Attempt-Lifecycle, Abort/Timeout, Serialisierung, Fence, Resultatcodes |
| Persistenz | `session-store.ts`, DB-Schema und SQLite/Postgres-Migrationen | Sequenz-Checkpoint, Attempt-Ledger, CAS-Summary-Commit |
| Live Runtime | `live-runtime.ts`, `runtime-service.ts`, `session-operation-lock.ts` | Turnintegration, Manual/Auto, Dispose, Events, Status |
| Automation | `app/lib/automations/runner.ts` | gleicher Planner/Commit unter exklusiver Sessionausfuehrung |
| Multimodal | `message-normalization.ts`, `multimodal-preparation.ts` | Payload-Evidenz aus dem bereits autorisierten Bildpfad |
| Web UI | Canvas-Agent-Chat Hooks/Komponenten und Chat-Typen | Statusanzeige, Abbruch, Deduplikation, Reload, Handlungshinweise |
| Tests | fokussierte Scripts plus spaeter `tests/pi-chat.spec.ts` | Contracts, DB, Runtime, UI und explizit freigegebene E2E-Abnahme |

Managed Delegations erben den Live-Runtime-Vertrag. Ephemeral Worker bleiben
zunaechst eine dokumentierte Grenze; falls die Reproduktion dort ebenfalls
Kontextkomprimierung erfordert, wird ihr `agentLoop()` in einer eigenen,
anschliessenden Phase auf den Planner gehoben, ohne den Live-Runtime-State zu
imitieren.

## Sequenzieller Implementierungspfad

### Phase 0: Budgetanalyse und Vertragsbaseline (abgeschlossen)

1. Aktuellen Canvas-Requestpfad und Hermes-Budgetmodell codebasiert
   vergleichen.
2. Vollstaendigen Payloadumfang, Output-Cap, Safety-Reserve,
   Tokenizerunsicherheit, Multimodalachsen und Invalidierungsgrenzen als
   Budgetvertrag festlegen.
3. Hermes-spezifische Konstanten und Mechanismen explizit ausschliessen.
4. Provider-Usage als fingerprintgebundene Evidenz mit Konfidenz statt als
   universelle Wahrheit definieren.

**Gate:** Erfuellt durch die dokumentierte Budgetanalyse. Die exakte
PI-Agent-Core-Hookreihenfolge bleibt mangels installierter Dependencyquelle
eine Integrationsunsicherheit und wird durch Adaptertests statt Annahmen
abgesichert.

### Phase 1A: Final-Payload-Budgetvertrag (erste Implementierungsphase)

1. `PiContextBudgetSnapshot`, validierte `PiContextBudgetPolicy` und einen
   einzigen Builder einfuehren.
2. Fuer den Hauptmodellpfad einen expliziten Output-Cap setzen und exakt
   denselben Wert im Snapshot reservieren.
3. Effektive Anweisungen, final serialisierte Nachrichten, effektive
   Toolschemas, Runtime-/Provideroverhead sowie finale Bildtoken-/Byteevidenz
   getrennt zaehlen.
4. Fingerprints fuer Modell/Limitmetadaten, Prompt, Tools, Runtimepolicy,
   Multimodalnormalisierung und Payload bilden; Inhalte selbst nicht loggen.
5. Kalibrierungsevidenz mit Quelle, Konfidenz und exaktem Contractfingerprint
   modellieren; keine Schaetzung global ueberschreiben.
6. Nachrichteneinheiten bilden und ToolCall/Result-Gruppen bei jeder
   Raw-History-Auswahl ungeteilt halten.

**Gate:** Fokussierte Contracttests fuer Budgetgleichung, echten Output-Cap,
Fingerprintinvalidierung, Multimodal-/Byteachsen, Konfidenz und Toolatomizitaet
gruen; Lint und Build gruen. Fokussierter Commit.

### Phase 1B: Pure Kompositionsvertraege

1. Soft-Trigger, Target-Tail und Hardlimit im Summary-Planner anwenden.
2. Summary/Raw-Tail strikt nach Sequenz entueberlappen; Break-Marker aus der
   LLM-Entscheidung entfernen.
3. Aktuelle Nutzer-/Tool-/Bild-Einheit als unteilbaren Tail schuetzen.
4. Bestehende Exporte nur ueber Adapter weiterfuehren und alle Consumer auf
   denselben Snapshot umstellen.

**Gate:** Unit-/Contract-Matrix gruen; vorhandener First-Message-, Byte- und
Summary-Test bleibt gruen. Fokussierter Commit.

**Technischer Stand 2026-08-26:** Umgesetzt. Die Contract-Matrix deckt
Raw-only unterhalb des Triggers, Target-Auswahl oberhalb des Triggers,
disjunkte Sequenzabdeckung, fehlendes Raw-Praefix, Markerfreiheit,
Toolatomizitaet, aktuelle Einheit, zu grosse aktuelle Einheit sowie sicheren
und unsicheren Summary-Fehlerfallback ab. Browser-/Provider-/Langchat-Abnahme
ist damit nicht ersetzt und bleibt offen.

### Phase 2: Additives Datenmodell und atomare Store-APIs

1. `summary_revision` und Attempt-Ledger in SQLite und PostgreSQL additiv
   migrieren.
2. Start-, Failure- und CAS-Erfolgsoperationen transaktional implementieren.
3. Nachrichtenpersistierung einen Sequenz-Checkpoint zurueckgeben lassen und
   `(session, sequence)`-Integritaet pruefen. Ein Unique-Index wird erst nach
   einem Migrationsaudit vorhandener Duplikate aktiviert.
4. `savePiSession()` daran hindern, Summary-Zustand ohne erwartete Revision zu
   ueberschreiben.
5. Scope- und Race-Tests fuer User, Agent, Workspace-gebundene Session,
   parallelen Append und parallelen Summary-Commit hinzufuegen.

**Gate:** SQLite- und PostgreSQL-Vertrag, Rollback bei injiziertem
Zwischenfehler und alter Datenbestand gruen. Fokussierter Commit.

**Technischer Stand 2026-08-27:** Umgesetzt. `pi_sessions` besitzt jetzt eine
monotone `summary_revision`; das neue Attempt-Ledger speichert nur Scope-,
Revisions-, Watermark-, Budget- und Ergebnis-Metadaten, jedoch keine Prompt-,
Nachrichten- oder Summary-Inhalte. Seine partielle Eindeutigkeit erlaubt
hoechstens einen laufenden Versuch pro persistierter Session.

SQLite und PostgreSQL migrieren additiv. Vor Aktivierung des eindeutigen
`(pi_session_db_id, sequence)`-Index wird der Altbestand geprueft. Bei einem
Konflikt bleibt der Verlauf unveraendert, der Index wird inhaltsfrei
aufgeschoben und die Komprimierung verweigert einen nicht lueckenlos
checkpointbaren Verlauf.

Die neuen Store-Operationen starten und beenden Versuche transaktional und
committen eine Summary nur, wenn User-, Agent-, Workspace- und Session-Scope,
Basisrevision, bisheriger Watermark und persistierter Nachrichtencheckpoint
noch passen. Der Erfolgscommit schreibt Summary, Through-Sequenz,
persistierten Grenzzeitstempel, neue Revision und Attempt-Ergebnis in einer
Transaktion. Ein parallel oberhalb des Checkpoints angehaengter Turn bleibt
erhalten. Stale-, Timeout- und Fehlerzustaende schreiben nur inhaltsfreie
Grundcodes.

`savePiSession()` gibt den dauerhaften Nachrichtencheckpoint und die aktuelle
Summary-Revision zurueck. Append und Full-save pruefen vor und nach dem
Schreiben eine lueckenlose Sequenz; allgemeine Summary-Schreibpfade benoetigen
eine erwartete Revision. Die No-op-Finalisierung verbindet Revisionstest und
eventuelle Nachrichtenkuerzung in einer Transaktion, sodass ein verlorener
CAS keine Nachrichten entfernt.

Die fokussierten Tests laufen fuer SQLite und den eingebetteten PostgreSQL-
Pfad und decken additive/erneute Migration, Altbestand, Scope-Trennung,
Unique-Audit, parallelen Start, parallelen Append, erfolgreichen und stale
CAS, injizierten Zwischenfehler mit Rollback, Failure-Abschluss sowie stale
allgemeine Saves und No-op-Rollback ab. Diese Phase stellt die sicheren
Persistenzprimitiven bereit; der produktive Auto-/Manual-/Automation-Ablauf
wird erst in Phase 3 bis 5 auf das Attempt-Ledger und den exklusiven
Candidate/Commit-Pfad umgestellt.

### Phase 3: Coordinator, Abort, Timeout und Retry

1. Pro-Session-Coordinator und Attempt-State-Machine implementieren.
2. Private Candidate-Erzeugung von Commit/Runtime-Uebernahme trennen.
3. Abort/Dispose/Timeout/Generation-Fence und late-result-Tests bauen.
4. persistierten Auto-Cooldown, manuelles einmaliges Bypass und Reset nach
   Erfolg implementieren.
5. Content-freie Metriken und Grundcodes zentralisieren.

**Gate:** Keine simulierte spaete Promise-Aufloesung kann Summary, Marker,
Cooldown oder Sessionzustand aendern; zwei Versuche erzeugen hoechstens einen
Summary-Providercall und einen Commit. Fokussierter Commit.

**Technischer Stand 2026-08-27:** Umgesetzt und inzwischen ueber Phase 4 in
die Live-Runtime integriert, aber noch nicht in Automation.
`session-compaction-coordinator.ts`
registriert pro User-/Session-/Agent-Scope genau einen lokalen Versuch; der
persistierte partielle Unique-Index erzwingt dieselbe Grenze pro Datenbank auch
zwischen Prozessen. PostgreSQL erzeugt die Attempt-Indizes explizit, weil die
gemeinsame Schema-zu-PostgreSQL-Migration Drizzle-Indexdefinitionen nicht
automatisch uebernimmt.

Jeder Versuch besitzt Attempt-ID, immutable Generation, eigenen
`AbortController`, Canvas-Policy fuer Gesamt-Timeout und injizierbare,
begrenzte Retry-Abstaende. Kandidatenerzeugung ist ein privater Callback; nur
der Coordinator darf danach den revisions-/watermark-geprueften Store-Commit
aufrufen. Abort, Invalidation oder Timeout beenden den Attempt, konsumieren
ein spaetes Providerergebnis ohne Commit und uebernehmen weder Summary noch
Runtimezustand. Ein Providerfehler wird nur dann `deferred`, wenn der bereits
berechnete vollstaendige Fallback sendbar ist.

Cooldown bleibt im Attempt-Ledger ueber `retry_at` restartfest. Automatische
und Automation-Versuche respektieren ihn; ein manueller Versuch darf ihn
einmal umgehen. Eine monotone `attempt_ordinal` macht Reihenfolge, Failure-
Zaehler und Success-Reset auch bei mehreren Abschluessen in derselben Sekunde
deterministisch. Die Defaultzeiten sind Canvas-Policy und in Tests ersetzbar,
nicht aus Hermes kopierte Konstanten.

Fokussierte Tests decken Single-flight, hoechstens einen Kandidatencall,
Generation vor/nach Providerwait, Abort, ignoriertes Provider-Abortsignal,
Timeout und spaetes Ergebnis, no-op/deferred, Persistenzfehler,
Cooldown/Manual-Bypass/Success-Reset sowie die zugehoerigen SQLite- und
PostgreSQL-Indizes/Migrationen ab.

### Phase 4: Live-Runtime und manueller Control-Pfad

1. `transformContext()` auf den Coordinator umstellen.
2. Bei optionalem Summary-Fehler nur dann den vollstaendigen Rohkontext
   verwenden, wenn der Planner dessen Hardlimit belegt; sonst vor dem
   Hauptmodellaufruf eindeutig abbrechen.
3. `compactNow()` durch den gemeinsamen Startpfad ersetzen und den langen
   Providerwait aus dem allgemeinen Session-Operation-Lock loesen.
4. `abort()`, `dispose()`, Runtime-Invalidierung, Modell-/Tool-Reload und
   Sessionwechsel mit Compaction-State koordinieren.
5. `recordCompaction()` erst nach Commit ausfuehren und Marker nicht mehr als
   Budget-/Summary-Signal verwenden.
6. Sequenz-Checkpoint nach jedem Save in den Live-State uebernehmen.

**Gate:** Fake-Stream-Integration fuer langer Textchat, Toolloop, Summary-
Fehler, Abort, Timeout, Manual/Auto-Race, Providerfehler und Runtime-Reload
gruen. Fokussierter Commit.

**Technischer Stand 2026-08-27:** Der produktive `transformContext()`- und
`compactNow()`-Pfad verwendet den gemeinsamen Coordinator. Vor dem Attempt
werden neue Nachrichten dauerhaft gespeichert und mit ihrer echten Sequenz
gestempelt. Erst der erfolgreiche CAS-Commit aktualisiert den Live-Summary-
State, emittiert das Erfolgsevent und haengt einen Break-Marker mit derselben
Attempt-ID an. Ein optionaler Summary-Fehler darf nur mit einem erneut
geprueften, vollstaendigen Hardlimit-Fallback fortfahren.

Die Runtime-Generation bindet Modell/Provider, Kontextfenster, den tatsaechlich
gesendeten Output-Cap, Summary-Revision/Watermark, Nachrichtencheckpoint,
Workspace, effektiven Prompt, effektive Toolschemas und Turn-Runtimekontext.
Prompt-, Tool-, Browser-/Workspace- und sonstige Runtimeaenderungen
invalidieren einen laufenden Versuch. `abort()` und `dispose()` erreichen den
Compaction-Controller direkt; Timeout-, Abort- und Stale-Ergebnisse werden
auch bei spaeter Provideraufloesung nicht uebernommen.

Der Fake-Stream-Integrationstest deckt erfolgreichen Commit und Reload,
Manual/Auto-Single-flight, Abort, Runtime-Invalidierung, Timeout und spaete
Ergebnisse ab. Coordinator-, Summary-, History- und Multimodaltests decken
Providerfehler, sicheren/unsicheren Fallback und atomare Toolgruppen ab. Dabei
wurde ein zusaetzlicher Revisionsfehler behoben: Der Commit gibt nun exakt den
sekundengenau persistierten Summary-Zeitstempel zurueck, sodass ein spaeterer
Nachrichtenappend keine scheinbare Summary-Aenderung und keine falsche zweite
Revision erzeugt. Manuelle Browser-/Provider-/Langchat-Abnahme bleibt Phase 7.

### Phase 5: Automation und weitere Runtime-Consumer

1. Automation auf Candidate/Commit/Revision umstellen; keine Summary mehr
   ueber allgemeine Saves oder No-op-Finalisierung schreiben.
2. Erfolgs-, No-op-, Retry- und Abbruchpfad gegen denselben Watermark testen.
3. Managed Delegation ueber Live-Runtime abdecken.
4. Ephemeral Delegation anhand Phase-0-Evidenz entweder explizit ausserhalb
   lassen oder als separat reviewbaren Schritt integrieren.
5. Telegram-/sonstige Kanalbefehle pruefen, da sie denselben manuellen
   Control-Pfad verwenden sollen.

**Gate:** Reload-/Retry-Faelle erzeugen keine doppelte Summary und keine
sessionfremde Uebernahme. Fokussierter Commit.

**Technischer Stand 2026-08-27:** Die persistente Automation verwendet mit
`automations/history-compaction.ts` denselben Coordinator, Attempt-Store und
CAS-Commit wie Live/Manual. Kurze Verlaeufe bleiben ohne Attempt auf dem
vollstaendigen Raw-Pfad. Lange Verlaeufe binden Modell-/Providerlimits,
Output-Cap, Summary-Revision/Watermark, Nachrichtencheckpoint, Workspace,
Runtime-Policy/-Katalog, effektiven Prompt, Toolschemas und aktuellen
Automation-Prompt in einen inhaltsfrei gespeicherten Generation-Fingerprint.
Abort, Cooldown, Providerfehler und unsicherer Hardlimit-Fallback folgen dem
gemeinsamen Coordinatorvertrag.

Allgemeine Prompt-, Ergebnis-, Fehler- und No-op-Saves erhalten keinen
Summary-Kandidaten mehr. Nur der Coordinator darf den Summaryzustand
schreiben; normale Saves lesen danach lediglich die aktuelle Revision zurueck.
Ein SQLite-Integrationstest prueft einen echten Automation-Commit, Promptsave,
Reload und einen anschliessenden monotonen Watermark-Fortschritt ohne erneute
Abdeckung des bereits committeten Bereichs. Der bestehende Runner-Test deckt
weiterhin Erfolg, Fehler/Retry, Abbruch, exklusiven Sessionzugriff, Runtime-
Pinning, Tools und Delivery ab.

Managed Delegations laufen bereits ueber die Live-Runtime. Der Telegram-
`/compact`-Befehl delegiert an deren gemeinsamen manuellen Control-Pfad.
Ephemeral Delegations bleiben entsprechend der dokumentierten Phase-0-Grenze
bewusst ausserhalb: Sie besitzen keinen wiederaufnehmbaren Parentverlauf und
erhalten in Ticket 28 keine nachgebaute Session-Rotation oder Hermes-Mechanik.

### Phase 6: Web-Status und Reload-Darstellung

1. Chat-/WebSocket-Typen um `compactionStatus` und Attempt-ID erweitern.
2. Running-, Success-, No-op-, Deferred-, Too-large-, Failed- und
   Aborted-Zustaende ruhig darstellen.
3. Compact-Aktion waehrend eines Versuchs deduplizieren; Abort erreichbar
   machen.
4. Marker/Event bei Reconnect, Pagination und Status-/Nachrichten-Race nach
   Attempt-ID deduplizieren.
5. Keine Summary oder Inhaltsmetadaten in Clientpayloads aufnehmen.

**Gate:** Component-/Hook-Tests gruen. Browser-/Playwright-E2E erst nach
expliziter Freigabe; UI-Commit getrennt von den Runtime-/DB-Commits.

**Technischer Stand 2026-08-27:** `PiRuntimeStatus` transportiert nun einen
verschachtelten, inhaltsfreien `compactionStatus` mit Zustand, Attempt-ID,
Trigger, stabilem Grundcode, Retry-Zeitpunkt und ausgelassener Anzahl. Die
Live-Runtime publiziert `running` vor dem privaten Providerwait und den
terminalen Zustand erst aus dem Coordinatorergebnis. Summarytext, Prompt,
Nachrichten, Toolargumente und Anhaenge sind nicht Bestandteil des Payloads.

Die Chat-UI zeigt lokalisierte, ruhige Hinweise fuer Running, Success, No-op,
Deferred, Too-large, Abort, Stale und Failure. Ein laufender Versuch sperrt
die doppelte Compact-Aktion und macht den bestehenden Stop-/Abort-Pfad
erreichbar. Erfolgsevent, Status und persistierter Break-Marker tragen dieselbe
Attempt-ID; Hook und Reload-Mapping deduplizieren bevorzugt danach und nutzen
nur fuer Legacy-Marker den Zeitstempel. Ein manueller No-op kann dadurch nicht
mehr versehentlich den vorherigen Erfolg erneut darstellen.

Der nicht-browserbasierte UI-Contracttest prueft Zustandszuordnung,
Too-large-Klassifikation, Attempt-ID-Restore und das Fehlen von Inhaltsfeldern.
Der Live-Fake-Stream-Test prueft zusaetzlich Running-/Terminalstatus fuer
Success, Abort, Stale und Timeout. Die vorhandene Playwright-Spezifikation ist
typisiert aktualisiert, wurde gemaess Nutzerfreigabe-Regel aber nicht
ausgefuehrt; visuelle/manuelle Abnahme bleibt Phase 7.

### Phase 7: Gesamtabnahme und Rollout

1. Fokussierte Tests aus allen Phasen, relevante bestehende PI-/Automation-/
   Multimodal-/DB-Tests, Lint und `npm run build` ausfuehren.
2. Nach expliziter Freigabe die manuelle Matrix unten auf `localhost:3000`
   pruefen; keinen zweiten Dev-Server starten.
3. Content-freie Diagnosewerte aus den kontrollierten Runs dokumentieren.
4. Zuerst additive Migration und Serververtrag, danach Web-UI ausrollen.
5. Ticket und Index erst nach vollstaendiger technischer und manueller Abnahme
   aktualisieren; dieser Plan nimmt die Abnahme nicht vorweg.

**Automatisierter Gate-Stand 2026-08-27:** Die fokussierten Summary-,
Budget-, Store-, Coordinator-, Revision-, Live-, UI-Contract-, Continuation-,
Attachment-, Multimodal-, Vision-Fallback- und Automation-Tests sind gruen.
`npm run lint` ist ohne Fehler durchgelaufen (nur bereits vorhandene Warnungen
aus nicht zu Ticket 28 gehoerenden Dateien), ebenso `npm run build`. Der Build
meldete ausschliesslich die in der lokalen Umgebung fehlende Auth-Base-URL als
Warnung. Diese Evidenz ersetzt weder die externe Providerkalibrierung noch die
unten beschriebene manuelle Browser-/Reload-/Langchat-Abnahme; Phase 7 und das
Ticket bleiben deshalb offen.

## Automatisierte Testmatrix

### Budget und Komposition

| Fall | Erwartung |
| --- | --- |
| Unter Soft-Trigger | kein Attempt, vollstaendiger Kontext |
| Genau am Soft-Trigger | ein planbarer Attempt, ausreichend Hardlimit-Reserve |
| Zwischen Trigger und Hardlimit | Summary-Kandidat + Tail unter Target |
| Genau am Hardlimit | kein stilles Ueberschreiten, deterministisches Ergebnis |
| Neueste Einheit allein zu gross | `latest_unit_too_large`, kein Summarycall |
| Systemprompt + Tools + Reserve zu gross | `fixed_context_too_large` |
| Multi-Byte-/Code-/JSON-Text | Sicherheitsreserve verhindert bekannte Unterzaehlung |
| 8-MB-History-Bytegrenze | klarer Bytefehler, keine Nachricht entfernt |
| Summary selbst zu gross | begrenzt oder abgewiesen; `includedSummary` bleibt korrekt |
| Groesseres Modell nach Compact | entweder Raw-only oder Summary + `seq>N`, nie Ueberlappung |
| Kleineres Modell nach Compact | Summary und vollstaendiger aktueller Tail passen oder klarer Fehler |
| Break-/Auth-Marker | nie im LLM-Budget/Payload, nur UI-Metadaten |

### Reihenfolge und Toolverlauf

| Fall | Erwartung |
| --- | --- |
| einzelner ToolCall + Result | beide im Tail oder beide in Summary-Mittelteil |
| parallele ToolCalls | Assistant-Call und alle zugehoerigen Resultate ungeteilt |
| mehrere Toolketten | Schnitt nur zwischen validen Einheiten |
| laufender ToolCall ohne Resultat | geschuetzt oder `active_tool_chain`, nie gestripped |
| langer Read-/Edit-Output | bounded Summaryinput, exakte relevante Pfade/Ergebnisse im Summaryvertrag |
| Runtime-Continuation | nicht als neue Nutzeranweisung interpretiert |

### Sequenz, Persistenz und Reload

| Fall | Erwartung |
| --- | --- |
| neue Live-Nachrichten gespeichert | In-Memory-Sequenzen erst nach Commit gesetzt |
| Reload nach Summary | exakt dieselbe `summaryRevision` und Through-Sequence |
| out-of-order Timestamps | Sequenz bleibt allein autoritativ |
| bereits zusammengefasste Nachricht nach Reload | nicht erneut im Summaryinput |
| paralleler Append waehrend Summary | Append bleibt Tail oberhalb Watermark |
| zwei Summary-Commits | genau ein CAS-Erfolg, zweiter `stale` |
| injizierter DB-Fehler | weder halbe Summary noch Erfolgsattempt |
| Session/User/Agent verwechselt | serverseitig abgewiesen, kein Datenleck |
| Legacy Summary ohne Sequenz | konservativer Legacy-/Rebuild-Pfad, keine Loeschung |
| Modell-/Providerwechsel | neuer Budget-Snapshot, gleiche kanonische Fortsetzung |

### Fehler, Abbruch und Retry

| Fall | Erwartung |
| --- | --- |
| Summary stopReason error/aborted | kein Commit; optional Raw-only nur wenn Hardlimit passt |
| Providerexception | klassifizierter Grund, Originalverlauf unveraendert |
| Timeout vor Ergebnis | Attempt `timed_out`, spaetes Ergebnis verworfen |
| Abort unmittelbar vor Commit | Fence verliert, kein Commit/Marker |
| Abort nach abgeschlossenem Commit | commit bleibt konsistent; Hauptturn stoppt normal |
| Runtime dispose/reload | alte Generation kann nicht committen |
| Auto + Manual gleichzeitig | ein aktiver Attempt; definierter gemeinsamer Status |
| wiederholter Auto-Fehler | hoechstens ein Versuch pro Turn, persistierter Cooldown |
| Manual waehrend Cooldown | genau ein expliziter Versuch, keine Schleife |
| klassifizierter Context-Overflow | hoechstens eine Compact-and-retry-Runde |
| anderer Providerfehler | keine Overflow-Retry-Runde |

### Multimodal

| Fall | Erwartung |
| --- | --- |
| direktes Bild + Text | aktueller Turn geschuetzt, finale Byteevidenz budgetiert |
| Read-Tool-Bild | Toolgruppe gueltig, Bild nicht im Summarytext |
| Bild nach Reload | kontrollierter Persistenzplatzhalter, keine fremden Bytes |
| mehrere Bilder ueber Total-Limit | bestehender Ticket-26-Fallback + korrekter Budgetstatus |
| nicht visionfaehiges Modell | Ticket-26-Textfallback, kein falscher Summary-Erfolg |
| unberechtigter/zu grosser Anhang | vor Provider-/Summary-Aufruf abgewiesen |

### UI/Events

| Fall | Erwartung |
| --- | --- |
| Manual gestartet | `compacting`, Aktion dedupliziert, Abort erreichbar |
| automatischer Erfolg | genau ein Commit-Event und Break pro Attempt-ID |
| Reconnect waehrend Versuch | persistierter Zustand ersetzt stale Clientstatus |
| Nachrichten-Pagination | kein doppelter oder falsch einsortierter Break |
| No-op | „bereits optimiert“, kein Erfolgsmarker mit Omitted-Count |
| latest unit too large | konkrete Kuerzen-/Modellwechsel-Aktion |
| Summary-Fehler/Cooldown | Retry-Zeitpunkt, kein leerer/hangender Chat |
| alle Statuspayloads | kein Summarytext, keine Anhaenge, Pfade oder Credentials |

## Manuelle Abnahme nach expliziter Freigabe

1. **Langer Textchat:** Einen kontrollierten Auftrag mit Entscheidungen,
   Dateipfaden, erledigten und offenen Schritten ueber den Soft-Trigger fuehren.
   Genau eine Auto-Komprimierung beobachten und den naechsten Turn auf alle
   Anker pruefen.
2. **Toolintensiver Chat:** Mehrere Read-/Edit-Aufrufe mit langem Output,
   paralleler Toolgruppe und finaler Antwort erzeugen. Nach Compact und Reload
   eine Folgeaenderung anweisen; keine Provider-Toolsequenzfehler und kein
   Wiederholen erledigter Arbeit.
3. **Bild/Attachment:** Ein autorisiertes kontrolliertes Testbild direkt und
   ueber `read` verwenden. Budgetstatus, Vision-/Textfallback und Reload
   pruefen; keine Bilddaten in Log/UI.
4. **Abort/Timeout:** Manuelles Compact starten und abbrechen; danach Session
   neu laden und kontrolliert erneut versuchen. Originalverlauf und aktuelle
   Aufgabe bleiben erhalten.
5. **Concurrency:** Auto-Trigger waehrend eines Turns, nahezu gleichzeitig
   manuellen Befehl und Reconnect ausloesen. Nur eine Attempt-ID und ein Commit.
6. **Modellwechsel:** Nach Compact auf groesseres und kleineres Modell wechseln.
   Weder Summary/Rohhistorie doppeln noch relevante Tail-Nachrichten verlieren.
7. **Automation/Managed Agent:** Persistente Automation beziehungsweise
   Managed-Delegation zweimal laufen lassen, dazwischen Reload. Summary-Grenze
   steigt monoton; keine sessionfremde Aufgabe.
8. **UI-Aktionen:** Running, Success, No-op, Too-large, Failure und Cooldown in
   Desktop- und Mobile-Breite pruefen.

## Abnahmematrix gegen Ticket 28

| Ticket-Kriterium | Technischer Nachweis | Manueller Nachweis |
| --- | --- | --- |
| langer Textchat laeuft weiter | Soft-trigger-, Fence-, Commit- und Reload-Integrationstest | Fall 1 |
| Toolverlauf bleibt providerkonform | Unit-Gruppierung + Fake-Provider-Contract | Fall 2 |
| Bild-/Anhangsbudget korrekt | Ticket-26-Payload-Evidenz + Multimodal-Matrix | Fall 3 |
| Fehler/Timeout/Abort destruktionsfrei | Deferred-Promise-, Transaction-Rollback- und Cooldown-Tests | Fall 4 |
| Manual/Auto/Reload ohne Doppelung | Attempt-CAS-, Generation- und Dedupe-Tests | Fall 5 |
| exakte Sequenzfortsetzung | Persistenz-/Reload-/Out-of-order-Tests | Faelle 1, 6 |
| klare UI und naechste Aktion | Hook-/Component-Statusmatrix | Fall 8 |
| Scope/Secrets erhalten | negative Scope- und payload-/log-redaction-Tests | kontrollierte Logpruefung |

## Migration und Rueckwaertskompatibilitaet

### Additive Migration

- `summary_revision` startet fuer bestehende Sessions bei `0`.
- Die Attempt-Tabelle ist additiv; bestehende Summary-Felder bleiben lesbar.
- Es werden bei der Migration keine `pi_messages` geloescht, umsortiert oder
  in eine Summary ueberfuehrt.
- Vor einem Unique-Index auf `(pi_session_db_id, sequence)` prueft ein
  Migrationsaudit doppelte/Null-/Nullsequenzen. Bei Befund wird nicht
  automatisch destruktiv repariert; die Migration bleibt diagnostisch und
  ein eigener Datenfix folgt.

### Legacy Summary

- `summaryThroughSequence` vorhanden: als Revision 0 laden und beim ersten
  erfolgreichen CAS-Commit auf Revision 1 heben.
- Nur Timestamp vorhanden: Summary als `legacy_pending_rebuild` markieren.
  Wenn Raw-Historie passt, vorerst Raw-only verwenden. Wenn Komprimierung
  erforderlich wird, aus einem persistierten Sequenzpraefix neu aufbauen und
  erst dann eine Sequenzgrenze committen.
- Summary ohne Text oder mit ungueltiger Grenze: ignorieren und content-frei
  diagnostizieren; Rohhistorie bleibt erhalten.

### API-Kompatibilitaet

- Bestehende lose Runtime-Felder bleiben waehrend einer Uebergangsphase aus
  `compactionStatus` abgeleitet, damit Web-/Mobile-/Kanalconsumer nicht
  gleichzeitig brechen.
- `context_compacted` bleibt ein Erfolgsevent. Neue Clients nutzen zusaetzlich
  Attempt-ID und Statusereignis.
- Alte `compact-break`-Nachrichten werden weiter dargestellt, beeinflussen
  aber niemals Budget oder Summary-Inklusion.

## Rollout und Rollback

1. Additive Schemaaenderung zuerst deployen; alte Applikationsversionen
   ignorieren die neuen Spalten/Tabelle.
2. Serverpfad mit neuem Planner/Commit aktivieren und alte Statusfelder
   weiterliefern.
3. Web-UI danach auf `compactionStatus` umstellen.
4. Erst nach stabiler Beobachtung Legacy-Schreibpfade entfernen.

Ein Applikationsrollback laesst Originalnachrichten und alte Summary-Felder
intakt. Die zusaetzliche Attempt-Tabelle und `summary_revision` muessen nicht
down-migriert werden. Solange der neue Server aktiv ist, darf kein alter
Server parallel Summary-Felder ohne Revision schreiben; gemischte
Serverversionen sind deshalb eine Rollout-Grenze. Bei kritischem Fehler wird
die automatische Ausloesung serverseitig deaktiviert und Raw-only verwendet,
solange das Hardlimit passt; manuelles Compact liefert dann eine klare
temporare Nichtverfuegbarkeit. Es werden keine Summaries oder Rohnachrichten
automatisch zurueckgeloescht.

## Risiken und Gegenmassnahmen

| Risiko | Gegenmassnahme |
| --- | --- |
| Token-Schaetzung bleibt ungenau | ein Builder, Soft-Trigger, Safety-Reserve, klassifizierter einmaliger Overflow-Recovery-Test |
| Summary halluziniert oder macht alte Aufgabe aktiv | strukturierter Prompt, untrusted Tags, explizite Endmarkierung, disjunkter aktueller Tail |
| Summary speichert sensible Daten | Sanitizer/Redaktion, keine Bilder/Thinking/rohen Tools, kein Inhalt in UI/Logs/Attemptdaten |
| CAS verwirft legitimen Versuch bei Append | Watermark deckt nur persistierten Praefix ab; Append oberhalb bleibt Tail |
| Prozess stirbt bei `running` | Attempt-Deadline und Reconciliation beim naechsten Zugriff |
| General Save ueberschreibt neue Summary | Summary-Schreiben nur mit Revision/Commit-Helper |
| Toolgruppe vergroessert geschuetzten Tail ueber Limit | frueher `latest_unit_too_large`/`active_tool_chain` statt invalider Providerpayload |
| UI-Event und paginierte DB-Historie doppeln Marker | Attempt-ID als Dedupe-Key, Marker nicht als LLM-Zustand |
| Schemaaenderung betrifft PostgreSQL/SQLite unterschiedlich | gleicher Contract-Test auf beiden Backends vor Runtimeintegration |
| Automation divergiert erneut | gemeinsamer Planner/Coordinator/Commit; kein eigener Summary-Save |
| Micro-Compaction verschlechtert Cache/Kosten | explizit nicht Teil dieses Tickets |

## Abhaengigkeiten und Integrationsgrenzen

### Ticket 18: Systemprompt und effektive Tools

Ticket 18 ist implementiert und in manueller Abnahme. Ticket 28 muss
`getEffectiveSystemPrompt()` und die tatsaechlich uebergebenen effektiven
`AgentTool[]` als Budgetquelle nutzen. Es darf keinen zweiten Toolmanifest-
Resolver einfuehren. Aenderungen an Tool-Reload, Planning Mode, Browser-
Aktivierung oder dynamischem Capability-Block invalidieren den Budget-Snapshot
des naechsten Turns, nicht einen bereits laufenden Summary-Snapshot.

### Ticket 26: Bilder aus Read-Tool und Attachments

Ticket 26 ist produktiv abgenommen. Ticket 28 verwendet dessen autorisierte
Normalisierung und Limits; es darf keine Dateipfade neu aufloesen, keine
Bildbytes persistieren und keinen Provider-Vision-Support selbst bestimmen.
Die gemeinsame Integrationsstelle ist die inhaltsfreie Payload-Evidenz vor der
finalen Budgetentscheidung.

### Provider-/Runtime-Auswahl

Modell-/Provider-Pinning und persoenliche/teamweite Credentials bleiben in der
Agent-Runtime-Policy. Die Summary nutzt denselben bereits aufgeloesten
`streamFn`, niemals den Legacy-API-Key-Resolver. Ein Modellwechsel erzeugt
einen neuen Budget-Snapshot, darf aber keine Summary einer fremden Session
laden.

### PI Agent Core

Der Plan setzt keine undokumentierte Reparatur in
`@earendil-works/pi-agent-core` voraus. Reichen die vorhandenen Hooks fuer
Provider-Overflow-Recovery, finalisierte Payload-Evidenz oder Progress nicht,
wird die kleinste gekapselte Adapteraenderung separat reviewt oder die
Bibliothek gezielt aktualisiert. Ein Dependency-Upgrade wird nicht beiläufig
mit Ticket 28 vermischt.

### Nicht-Ziele

- keine physische Loeschung/Archivierung alter Chatnachrichten;
- keine Hermes-Session-Rotation;
- keine Micro-Compaction oder allgemeine Prompt-Cache-Optimierung;
- kein neuer Summary-Provider oder nutzerwaehlbares Summary-Modell;
- keine Darstellung des Summary-Inhalts;
- keine Aenderung an Control Plane, Container oder Deploymentarchitektur;
- keine allgemeine Neuimplementierung des PI-Agentloops;
- keine automatische Aufnahme ephemeral Delegations ohne Phase-0-Evidenz.

## Reviewentscheidungen vor Implementierungsstart

Der Plan ist technisch umsetzbar, aber folgende Architekturpunkte sollen im
Planning Review explizit bestaetigt werden:

1. additive Attempt-Tabelle plus `summary_revision` statt nur
   prozesslokaler Locks;
2. Originalnachrichten bleiben nach Erfolg erhalten; Modellkontext wird
   logisch, nicht physisch komprimiert;
3. kein destruktiver statischer Fallback bei Summary-Fehlern;
4. vorgeschlagener 80/60-Trigger-/Target-Ausgangspunkt, final kalibriert in
   Phase 0;
5. positionsgenaue Break-Darstellung aus Attempt-Metadaten statt Marker als
   LLM-Nachricht;
6. Ephemeral Delegations bleiben initial ausserhalb, sofern Phase 0 dort
   keinen reproduzierbaren Bedarf belegt.

Keine dieser Reviewfragen blockiert die weitere Analyse; sie markieren die
Stellen mit der groessten langfristigen Daten- beziehungsweise UX-Wirkung.
