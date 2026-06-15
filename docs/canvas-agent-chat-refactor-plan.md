# Canvas Agent Chat Refactor Plan

Datum: 2026-06-15

## Ausgangslage

`app/components/canvas-agent-chat/CanvasAgentChat.tsx` ist aktuell die zentrale Datei fuer den Canvas Agent Chat und umfasst rund 7.176 Zeilen. Die Datei buendelt mehrere unterschiedliche Verantwortlichkeiten:

- Chat-Layout und Header/Composer/History-Rendering
- Session-Liste, Session-Auswahl, Rename/Delete/New-Chat
- Session-Cache in `sessionStorage`
- Message-Mapping von PI-Agent-Messages auf UI-Nachrichten
- WebSocket-Subscription und Runtime-Event-Reconciliation
- Tool-Run-Rendering und Queue-Interaktionen
- Scroll-Lock, Auto-Scroll und ResizeObserver-Verhalten
- Uploads, Attachment-Vorschau und Bild-Preprocessing
- Composer-Drafts, Input-History und Reference-Picker
- Agent-/Model-Auswahl und Plan-Mode-Integration

Das Problem ist nicht nur die Zeilenzahl. Die eigentliche Gefahr ist, dass mehrere unabhaengige Aenderungsgruende dieselbe Datei anfassen. Ein Layout-Fix, ein Upload-Bug, eine Runtime-Aenderung oder ein History/Unread-Fix koennen sich gegenseitig beeinflussen und Regressionen verursachen.

## Zielbild

`CanvasAgentChat.tsx` bleibt als schlanker Orchestrator erhalten. Die Datei soll Props entgegennehmen, spezialisierte Hooks verbinden und die grobe Oberflaeche zusammensetzen. Wiederverwendbare Mechanics wandern in Services und pure Helper; UI-Fragmente werden in praesentationale Komponenten geschnitten.

Gewuenschtes Ziel:

- Root-Komponente deutlich kleiner und leichter reviewbar
- klare Grenze zwischen UI, React-State, API-Zugriffen und purer Mapping-Logik
- bestehende `data-testid`-Werte bleiben stabil
- keine Design- oder Verhaltensaenderung im Struktur-Refactor
- jede abgeschlossene Phase ist buildbar, testbar und separat commitbar

## Architekturprinzipien

Dieser Refactor folgt einer Zwei-Schichten-Trennung:

- Orchestration/UI-Schicht: besitzt Produktlogik, UI-State, sichtbare Statusuebergaenge und user-facing Fehlerbehandlung.
- Service-/Helper-Schicht: besitzt wiederverwendbare Mechanik wie API-Requests, Mapping, Cache-Normalisierung und strukturierte Resultate.

Services duerfen keinen React-State mutieren und nicht heimlich in UI- oder Domain-Zustand greifen. Sie bekommen explizite Parameter und geben strukturierte Ergebnisse zurueck.

## Nicht-Ziele

- kein visuelles Redesign
- keine neue Chat-Architektur mit anderem Runtime-Protokoll
- keine Aenderung an API-Routen, sofern nicht zwingend erforderlich
- kein Container-Build, ausser er wird explizit angefordert
- kein Push
- keine parallelen Test-Container

## Arbeitsregeln

- Vor jedem groesseren Schritt `git status --short` pruefen.
- Bestehende fremde/lokale Aenderungen nicht zuruecksetzen.
- Pro abgeschlossener To-do-Einheit sauber committen.
- Nicht mit dem naechsten To-do weitermachen, wenn das aktuelle nicht verifiziert ist.
- Immer `npm run build` laufen lassen, bevor irgendein Container gebaut wuerde.
- Dev-Server ausschliesslich auf `localhost:3000` verwenden.
- Keinen neuen Dev-Server starten, wenn auf Port 3000 bereits einer laeuft.
- Port 3001 nicht verwenden.
- Playwright/Browser-UI-Pruefungen nur nach expliziter Freigabe fuer den jeweiligen Lauf starten.

## Phase 0: Baseline und Sicherheitsnetz

Ziel: Vor dem Refactor den Ist-Zustand festhalten und sicherstellen, dass wir nicht auf einem bereits kaputten Stand aufbauen.

Schritte:

1. `git status --short` pruefen.
2. Grobe Verantwortlichkeitskarte fuer `CanvasAgentChat.tsx` bestaetigen.
3. Aktuelle relevante Testabdeckung identifizieren:
   - `tests/pi-chat.spec.ts`
   - `tests/chat-file-reference-picker.spec.ts`
   - `tests/chat-cross-session-notifications.spec.ts`
   - `tests/home-chat-prompt.spec.ts`
   - optional `tests/e2e/studio-detail-chat.spec.ts`
4. Baseline-Verifikation:
   - `npm run lint`
   - `npm run build`
5. Falls Playwright freigegeben ist:
   - pruefen, ob `localhost:3000` bereits laeuft
   - wenn nicht, einen einzelnen Dev-Server auf Port 3000 starten
   - gezielte Chat-Specs gegen diesen Server laufen lassen

Akzeptanzkriterien:

- Baseline-Ergebnisse sind dokumentiert.
- Keine Code-Aenderung in dieser Phase ausser optionaler Dokumentation.

Commit:

- nur falls Dokumentation oder Test-Notizen entstehen.

## Phase 1: Typen und pure Helper extrahieren

Ziel: Nicht-React-Logik aus der grossen Komponente loesen, ohne Verhalten zu aendern.

Kandidaten fuer neue Dateien:

- `app/lib/chat/chat-message-types.ts`
- `app/lib/chat/message-mapping.ts`
- `app/lib/chat/session-cache.ts`
- `app/lib/chat/runtime-message-utils.ts`
- `app/lib/chat/attachment-message-utils.ts`

Zu extrahierende Logik:

- `ChatMessage`, `AISession`, `ChatEvent`, Cache-Typen
- Runtime-Phase- und Queue-Helfer
- Message-Vergleichsfunktionen
- PI-Message-Text- und Attachment-Extraktion
- Tool-Result-Mapping
- Session-Cache-Hydration, Persistenz, Trimming und Invalidierung
- Utility-Funktionen ohne React-Hooks und ohne DOM-Zugriff

Wichtige Regeln:

- Erst exportieren und in `CanvasAgentChat.tsx` wiederverwenden.
- Keine Semantik aendern.
- Keine UI-Komponente in dieser Phase verschieben.
- Keine Service-Schicht mit `fetch` in dieser Phase.

Tests:

- `npm run lint`
- `npm run build`
- wenn sinnvoll: kleine Script-Tests fuer Message-Mapping oder Cache-Normalisierung ergaenzen

Akzeptanzkriterien:

- `CanvasAgentChat.tsx` nutzt extrahierte Helper.
- Pure Helper sind ohne React importierbar.
- Build bleibt gruen.

Commit:

- `Extract chat pure helpers`

## Phase 2: API-Service-Schicht extrahieren

Ziel: Wiederverwendbare API-Mechanik aus der UI-Komponente herausziehen.

Kandidaten fuer neue Dateien:

- `app/lib/chat/chat-session-service.ts`
- `app/lib/chat/chat-message-service.ts`
- `app/lib/chat/chat-upload-service.ts`
- `app/lib/chat/reference-service.ts`

Service-Funktionen:

- `loadChatSessions(params)`
- `createChatSession(params)`
- `loadSessionMessages(params)`
- `loadOlderSessionMessages(params)`
- `markSessionAsRead(params)`
- `markAllSessionsAsRead(params)`
- `deleteChatSession(params)`
- `renameChatSession(params)`
- `uploadChatAttachments(params)`
- `loadReferenceFiles(params)`
- `loadReferenceSkills(params)`

Wichtige Regeln:

- Services mutieren keinen React-State.
- Services rufen keine UI-Funktionen wie `setMessages`, `setHistory`, `confirm` oder `prompt` auf.
- Services geben strukturierte Ergebnisse zurueck, z. B. `{ success, sessions }` oder werfen klar klassifizierbare Fehler.
- Produktentscheidungen bleiben in der Orchestration-Schicht.

Tests:

- `npm run lint`
- `npm run build`
- bestehende API-/Integrationstests, wenn eine Route oder ein Response-Shape beruehrt wird

Akzeptanzkriterien:

- `fetch`-Aufrufe fuer Chat-Sessions, Messages, Uploads und Referenzen sind aus der Komponente reduziert.
- Fehlerbehandlung bleibt sichtbar gleich.
- Build bleibt gruen.

Commit:

- `Extract chat API services`

## Phase 3: Stateful Hooks extrahieren

Ziel: React-State nach fachlichen Verantwortlichkeiten schneiden.

Kandidaten:

- `useChatScrollLock`
- `useChatSessionList`
- `useChatMessages`
- `useChatRuntimeEvents`
- `useChatComposerDraft`
- `useChatUploads`
- `useComposerReferences`
- `useChatAgentSelection`

Empfohlene Reihenfolge:

1. `useChatScrollLock`, weil es relativ isoliert ist.
2. `useChatComposerDraft`, weil es klar begrenzten Storage-State kapselt.
3. `useChatUploads`, weil Upload-State und Preprocessing zusammenhaengen.
4. `useComposerReferences`, weil File-/Skill-Picker klar abgrenzbar ist.
5. `useChatSessionList`, weil History/Unread mehr Seiteneffekte hat.
6. `useChatMessages`, weil Mapping, Pagination und Cache zusammenlaufen.
7. `useChatRuntimeEvents`, weil WebSocket-Reconciliation das hoechste Risiko hat.

Wichtige Regeln:

- Kein monolithischer `useCanvasAgentChat`.
- Jeder Hook hat explizite Inputs und Outputs.
- Refs, die Live-Event-Reconciliation brauchen, bewusst benennen.
- Keine Test-IDs oder sichtbare UI in Hooks.

Tests nach jeder groesseren Hook-Gruppe:

- `npm run lint`
- `npm run build`
- bei freigegebenem Playwright:
  - `tests/pi-chat.spec.ts`
  - `tests/chat-cross-session-notifications.spec.ts`
  - `tests/chat-file-reference-picker.spec.ts`

Akzeptanzkriterien:

- `CanvasAgentChat.tsx` verliert messbar State-/Effect-Komplexitaet.
- Runtime-, Queue-, Scroll- und Composer-Verhalten bleiben unveraendert.
- Build bleibt gruen.

Commits:

- `Extract chat scroll and composer hooks`
- `Extract chat upload and reference hooks`
- `Extract chat session hooks`
- `Extract chat runtime event hook`

## Phase 4: UI-Komponenten extrahieren

Ziel: JSX in praesentationale Komponenten schneiden, nachdem die Logik stabiler getrennt ist.

Kandidaten:

- `ChatHeaderBar.tsx`
- `ChatRuntimeBanner.tsx`
- `ChatHistoryPanel.tsx`
- `ChatMessageList.tsx`
- `ChatMessageBubble.tsx`
- `ToolMessageBubble.tsx`
- `ChatQueuePanel.tsx`
- `ChatComposer.tsx`
- `StarterPromptGrid.tsx`
- `ChatAgentSelector.tsx`

Wichtige Regeln:

- `data-testid` unveraendert lassen.
- Keine Style-Modernisierung in diesem Refactor.
- Props explizit halten.
- UI-Komponenten duerfen keine API-Requests ausloesen, ausser sie erhalten einen Handler als Prop.
- Keine Karten-in-Karten- oder Layout-Umbauten nebenbei.

Tests:

- `npm run lint`
- `npm run build`
- bei freigegebenem Playwright:
  - `tests/pi-chat.spec.ts`
  - `tests/home-chat-prompt.spec.ts`
  - `tests/e2e/studio-detail-chat.spec.ts`, falls Studio-Chat betroffen ist

Akzeptanzkriterien:

- Root-Renderblock ist deutlich kleiner.
- Komponenten sind fachlich benannt.
- Sichtbares Verhalten bleibt gleich.

Commits:

- `Extract chat history and header components`
- `Extract chat message rendering components`
- `Extract chat composer and queue components`

## Phase 5: Root-Orchestrator verschlanken

Ziel: `CanvasAgentChat.tsx` als Zusammensetzungsschicht stabilisieren.

Schritte:

1. Tote Imports und ungenutzte lokale Helper entfernen.
2. Abgeleitete View-State-Werte gruppieren.
3. Props und Handler-Namen vereinheitlichen.
4. Datei erneut messen:
   - Zeilenanzahl
   - Anzahl `useState`
   - Anzahl `useEffect`
   - Anzahl direkter `fetch`-Aufrufe
5. Nur falls noetig, kleine Rest-Helfer verschieben.

Akzeptanzkriterien:

- `CanvasAgentChat.tsx` ist klar als Orchestrator lesbar.
- Direkte API-Mechanik ist aus der Komponente verschwunden oder stark reduziert.
- Pure Logik ist testbar ausserhalb von React.
- Kein sichtbares Verhalten wurde absichtlich geaendert.

Commit:

- `Simplify canvas agent chat orchestrator`

## Verifikationsstrategie

Minimal nach jeder Phase:

- `npm run lint`
- `npm run build`

Gezielte Playwright-Specs nach Freigabe:

- `tests/pi-chat.spec.ts`
  - Streaming
  - Queue
  - Stop/Abort
  - Composer
  - Tool-Rendering
  - Attachments
- `tests/chat-file-reference-picker.spec.ts`
  - File-Reference-Picker
  - Skill-Reference-Picker
  - Keyboard-Auswahl
- `tests/chat-cross-session-notifications.spec.ts`
  - Unread-Badges
  - aktive vs. Hintergrund-Session
  - Mark-as-read
- `tests/home-chat-prompt.spec.ts`
  - Home-Prompt-Integration
  - Weiterleitung in Chat
- `tests/e2e/studio-detail-chat.spec.ts`
  - Studio-Chat-Kontext
  - Integration mit Dock/Shell

Empfohlene Playwright-Ausfuehrung, wenn ein Server auf `localhost:3000` laeuft:

```bash
E2E_EXTERNAL_SERVER=1 npm run test:e2e -- tests/pi-chat.spec.ts
E2E_EXTERNAL_SERVER=1 npm run test:e2e -- tests/chat-file-reference-picker.spec.ts
E2E_EXTERNAL_SERVER=1 npm run test:e2e -- tests/chat-cross-session-notifications.spec.ts
E2E_EXTERNAL_SERVER=1 npm run test:e2e -- tests/home-chat-prompt.spec.ts
```

Falls kein Server laeuft, nur einen Server auf Port 3000 starten. Keinen Port 3001 verwenden.

## Manuelle UI-Pruefpunkte

Nur nach Freigabe fuer UI-Pruefung:

- Chat auf `/chat` oeffnen
- neue Nachricht senden
- laufenden Run stoppen
- Follow-up waehrend Runtime busy queuen
- Queue-Item promoten, editieren und entfernen
- bestehende Session aus History laden
- Session umbenennen und loeschen
- Datei/Bild hochladen
- Reference-Picker mit `@"..."` und `/skill` testen
- Chat-Dock im Desktop-Sidepanel oeffnen/schliessen
- Chat-Dock fullscreen oeffnen
- Mobile Sheet pruefen, wenn relevant

## Risiken und Gegenmassnahmen

| Risiko | Gegenmassnahme |
|---|---|
| Streaming-Regressions durch Ref-Wechsel | Runtime-Hook spaet extrahieren und mit `pi-chat.spec.ts` absichern |
| Scroll-Spruenge bei Streaming/Bildern | `useChatScrollLock` isoliert extrahieren und bestehende ResizeObserver-Logik unveraendert uebernehmen |
| Queue-Status verliert lokale optimistic Messages | Queue-Reconciliation erst nach Message-Helper-Extraktion anfassen |
| Session unread/read-state wird falsch | `chat-cross-session-notifications.spec.ts` nach Session-Hook laufen lassen |
| Uploads verlieren Preview-Metadaten | Upload-Service erst nach Attachment-Helper-Extraktion schneiden |
| Merge-Konflikte mit parallelen UI-Aenderungen | Kleine Commits, keine kosmetischen Aenderungen |

## Rollback-Strategie

- Jede Phase ist ein eigener Commit oder eine kleine Commit-Gruppe.
- Wenn ein Test-Gate scheitert, wird innerhalb derselben Phase gefixt.
- Nicht in die naechste Phase wechseln, solange Build oder relevante Tests rot sind.
- Bei schwerer Regression nur den letzten Phasen-Commit rueckabwickeln, nicht den gesamten Refactor.

## Definition of Done

Der Refactor gilt als abgeschlossen, wenn:

- alle geplanten Verantwortlichkeiten aus `CanvasAgentChat.tsx` sinnvoll getrennt sind
- `npm run lint` erfolgreich ist
- `npm run build` erfolgreich ist
- freigegebene Playwright-Chat-Specs erfolgreich sind
- keine Container gebaut wurden
- alle fertigen To-dos sauber committed sind
- kein Push erfolgt ist
