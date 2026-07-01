# File Browser Refactor Plan

## Ziel

Der File-Browser soll von einem gewachsenen, stark gekoppelten Modul in eine klarere Struktur ueberfuehrt werden. Ziel ist keine neue Funktionalitaet, sondern geringere Kopplung, weniger doppelte Logik und bessere Wartbarkeit bei unveraendertem Verhalten.

Zusaetzliches Performance-Ziel ab Juli 2026:

- Tree/List/Grid sollen dieselben View- und Selection-Modelle verwenden.
- Sichtbare Item-Listen sollen memoisiert und nicht in jeder Item-Komponente neu hergeleitet werden.
- Item-Komponenten sollen weniger breit auf den globalen File-Store subscriben.
- Teure Tree-Suchen, Flattening und Restore-Logik sollen aus Render-Komponenten in kleine Hooks/Pure-Services wandern.

Grundprinzip aus dem `code-structure`-Skill:

- UI und Store orchestrieren Produktverhalten: Auswahl, Dialoge, aktive Datei, mobile/desktop Flows.
- Service- und Utility-Schichten kapseln wiederverwendbare Mechanik: Pfade, Tree-Operationen, Fetch/Error-Handling, Upload, Cache-Invalidierung, Filesystem-Zugriffe.
- Migration erfolgt schrittweise: einen Block extrahieren, einen Satz Verbraucher umstellen, verifizieren, dann weiter.

## Status Quo

Der File-Browser besteht aktuell aus mehreren gekoppelten Schichten:

- `app/components/file-browser/`: File-Browser UI, Tree/List/Grid, Dialoge, Context-Menues.
- `app/store/file-store.ts`: Zustand-Store, aber auch API-Client, Tree-Merge-Logik, Upload-XHR, Path-Helfer, Auswahlmodell und UI-State.
- `app/api/files/`: Route Handler fuer Tree, Read, Write, Create, Delete, Rename, Copy, Upload, Preview, Export und Watch.
- `app/lib/filesystem/workspace-files.ts`: serverseitige Workspace-Dateioperationen.
- `app/lib/utils/file-tree-cache.ts`: Tree Cache.
- `app/lib/filesystem/file-watcher.ts` und `app/lib/file-watcher/client.ts`: Server- und Client-Watcher.
- `app/lib/filesystem/file-reference-cache.ts` und `file-reference-search.ts`: Suchindex fuer File-Referenzen.

Aktueller Fortschritt:

- `app/lib/files/types.ts`, `path-utils.ts` und `tree-utils.ts` existieren und werden aktiv genutzt.
- `app/lib/files/client.ts` kapselt die meisten Browser-API-Aufrufe.
- `app/lib/files/operation-flows.ts` enthaelt erste gemeinsame Flow-Helfer wie geschuetzte Pfade und kompaktierte Copy-Selektionen.
- Copy/Paste behandelt verschachtelte Mehrfachauswahl und Partial-Failures inzwischen zentraler.

Offen:

- `file-store.ts` ist weiterhin ein grosser Orchestrierungs-Store mit Tree, Preview, Clipboard, Upload, Selection und Dialog-State.
- `FileGridView.tsx` enthaelt weiterhin Restore, Suche, View-Mode-Auswahl, Keyboard-Handling und Rendering fuer drei Darstellungen.
- `FileTreeNode.tsx` und `FileGridItem.tsx` abonnieren noch breite Store-Zustaende und koppeln Click-Semantik direkt an Rendering.
- `FileActionsDropdown.tsx` ist weiterhin ein Action-Controller mit vielen Dialog- und Operation-Flows.

Grobe Codegroesse der betrachteten Bereiche:

| Bereich | Physische Zeilen | Codezeilen grob |
|---|---:|---:|
| File-Browser UI-Komponenten | 4.501 | 4.093 |
| `FileNode.tsx.backup` | 216 | 185 |
| `file-store.ts` | 1.343 | 1.138 |
| `/api/files` Routen | 2.223 | 1.896 |
| Filesystem/Cache/Watcher/Search Support | 1.926 | 1.544 |
| Fokus-Tests/Scripts | 493 | 414 |
| Gesamt betrachtet | 10.702 | 9.270 |

## Hauptprobleme

### 1. Store als Mischschicht

`app/store/file-store.ts` ist aktuell gleichzeitig:

- Zustand-Store
- Browser API Client
- Error Response Parser
- Tree-Merge- und Refresh-Engine
- Upload-XHR-Client
- Clipboard- und Selection-Service
- LocalStorage-Persistenz
- Mobile UI State

Das macht Aenderungen riskant, weil technische Mechanik und Produktfluss in derselben Datei vermischt sind.

### 2. Wiederholte Pfad- und Tree-Logik

Aehnliche Helfer existieren in mehreren Dateien:

- Parent Directory ermitteln
- Pfade joinen
- Directory Chain berechnen
- Knoten im Tree suchen
- Subtree-Children finden
- File Size formatieren
- Pfadparameter normalisieren

Diese Logik sollte in client-sichere Pure-Utils ausgelagert werden.

### 3. UI-Komponenten enthalten operative Flows

Komponenten wie `FileActionsDropdown`, `BulkMoveDialog`, `FileBrowser`, `BackgroundContextMenu`, `CreateItemDialog` und `UploadDialog` enthalten teilweise Flow- und Operationslogik, die mehrfach vorkommt.

Besonders auffaellig:

- Create-Flow in Toolbar, Context-Menu und Background-Menu
- Move-/Rename-Konflikte in mehreren Pfaden
- Delete-Protection clientseitig und serverseitig
- Refresh nach Mutationen verteilt ueber Store, Komponenten und API-Routen

### 4. API-Routen wiederholen Boundary-Mechanik

Viele `/api/files` Routen wiederholen:

- Session Check
- Rate Limit
- JSON Body Parsing
- Error JSON Shape
- Cache-Invalidierung
- File-Reference-Invalidierung

Auth und Produktpolicy sollen in Route Handlern bleiben, aber die wiederverwendbare Boundary-Mechanik kann spaeter in kleine Helfer.

### 5. Watcher ist besser getrennt, aber noch store-gekoppelt

Der serverseitige Watcher ist relativ sauber als Service modelliert. Der Client-Watcher kennt aber direkt den File-Store und ruft Store-Actions auf. Das ist aktuell pragmatisch, sollte aber nach dem Store-Refactor ueber klarere Callback- oder Adapter-Grenzen laufen.

### 6. Render-Performance leidet unter breiten Store-Subscriptions

Aktuelle Item-Komponenten lesen mehrere globale Store-Felder direkt. Dadurch koennen einfache State-Aenderungen wie Loading, Selection oder Context-Menu-Zustand viele sichtbare Rows/Tiles neu rendern.

Ziel:

- Item-Komponenten erhalten stabile Props fuer Node, View-Mode und sichtbare Selection-Order.
- Store-Subscriptions in Items werden auf primitive Booleans und stabile Actions reduziert.
- View-Komponenten bauen sichtbare Listen mit `useMemo`.
- Gemeinsame Click-/Selection-Regeln werden aus Tree/List/Grid in Hooks oder Pure-Controller verschoben.

## Zielarchitektur

```text
UI-Komponenten
  - rendern
  - sammeln Nutzereingaben
  - oeffnen Dialoge
  - rufen Store-Actions auf

File Store
  - haelt UI- und Domain-State
  - orchestriert Produktfluesse
  - entscheidet ueber Selection, Current File, Current Directory
  - ruft Client-Services und Tree-Utils auf

Client Services
  - sprechen `/api/files/*`
  - normalisieren Response- und Error-Handling
  - kapseln Upload-XHR und Download-Trigger

Pure Utils
  - Path Utilities
  - Tree Utilities
  - File Type / Display Utilities

API Route Handler
  - authentifizieren
  - limitieren
  - validieren externen Input
  - treffen Route-/Policy-Entscheidungen
  - rufen Server-Services auf

Server Services
  - Workspace-Dateioperationen
  - Cache-Invalidierung
  - Watcher
  - Public Share Sync
```

## Umsetzungsplan

### Phase 1: Dokumentation und Baseline

1. Dieses Plan-Dokument anlegen.
2. Arbeitsbaum auf fremde Aenderungen pruefen und nur eigene Dateien stage/committen.
3. Keine Container bauen.
4. Kein Playwright ohne separate Freigabe.

Verifikation:

- Fuer reine Dokumentation kein Build erforderlich.

Status: erledigt, wird mit aktuellem Fortschritt fortgeschrieben.

### Phase 2: Shared Types und Pure Utils extrahieren

Neue Module:

- `app/lib/files/types.ts`
- `app/lib/files/path-utils.ts`
- `app/lib/files/tree-utils.ts`

Verschieben oder duplizierungsfrei zentralisieren:

- `FileNode`, `BrowserMode`, `FileStats`, `CurrentFile`
- `getParentDirectory`
- `getParentDirectories`
- `joinWorkspacePath`
- `normalizeWorkspacePathParam`
- `findNodeInTree`
- `findPathInTree`
- `flattenDirectoryChildren`
- `getDirectoryPathChain`
- `getDirectoryDepth`
- `mergeSubtreeChildren`
- `remapDescendantPath`

Regel:

- Nur client-sichere Pure Functions.
- Keine `fs`, keine DB, keine Fetches, keine Zustand-Abhaengigkeit.

Verifikation:

- `npm run test:file-watcher`
- `npm run lint`
- `npm run build`

Commit:

- `Extract file browser path and tree utilities`

Status: erledigt.

### Phase 3: Frontend Files API Client extrahieren

Neues Modul:

- `app/lib/files/client.ts`

Ziel:

- Fetch-URLs, Response-Parsing, Error-Parsing und Upload-XHR aus `file-store.ts` entfernen.
- Der Store ruft nur noch benannte Client-Funktionen auf.

Kandidaten:

- `loadWorkspaceTree`
- `readWorkspaceFile`
- `writeWorkspaceFile`
- `createWorkspacePath`
- `deleteWorkspacePaths`
- `renameWorkspacePath`
- `copyWorkspacePaths`
- `uploadWorkspaceFiles`
- `triggerWorkspaceDownload`

Regel:

- Client-Service macht keine Store-Mutationen.
- Store entscheidet weiterhin, welche Directories danach refreshen und welcher UI-State angepasst wird.

Verifikation:

- `npm run test:file-watcher`
- `npm run lint`
- `npm run build`

Commit:

- `Extract file browser API client`

Status: erledigt.

### Phase 4: Store intern verschlanken

Ziel:

- Tree-Merge, Restore und Refresh-Mechanik aus Inline-Blöcken auf Pure-Utils umstellen.
- Store-Actions lesbarer machen, ohne Verhalten zu aendern.

Kandidaten:

- `refreshRootTree`
- `refreshVisibleTree`
- `loadSubdirectory`
- `revealAndLoadFile`
- `renamePath`
- `selectRange`
- `selectAllInDirectory`

Regel:

- Keine UI-Umgestaltung.
- Keine neuen Product-Flows.
- Nur Mechanik entkoppeln.

Verifikation:

- `npm run test:file-watcher`
- `npm run lint`
- `npm run build`

Commit:

- `Simplify file store tree operations`

Status: teilweise erledigt. Tree- und Path-Utils sind extrahiert, aber Restore-/View-Model-Logik sitzt noch in `FileGridView.tsx`.

### Phase 5: Move/Create/Delete Dialog-Flows vereinheitlichen

Ziel:

- Doppelte Flow-Logik zwischen `FileActionsDropdown`, `BulkMoveDialog`, `FileBrowser` und `BackgroundContextMenu` reduzieren.
- Konfliktbehandlung fuer Move/Rename zentralisieren.

Moegliche Module:

- `app/lib/files/file-operation-flows.ts`
- oder ein kleiner Hook wie `app/components/file-browser/useFileOperationDialogs.ts`

Regel:

- UI bleibt in Komponenten.
- Wiederverwendbare Ablaufmechanik kommt in Hook/Flow-Modul.
- Keine serverseitige Policy in Client-Hooks verschieben.

Verifikation:

- `npm run test:file-watcher`
- `npm run lint`
- `npm run build`
- UI-Test nur nach Freigabe.

Commit:

- `Consolidate file browser operation flows`

Status: teilweise erledigt. Copy/Paste-Mechanik ist verbessert, Move/Create/Delete/Dialog-Flows sind noch verteilt.

### Phase 5a: View-Model und Selection-Controller extrahieren

Ziel:

- `FileGridView.tsx` von Tree/List/Grid-Datenermittlung entlasten.
- Sichtbare Items und Selection-Order fuer Grid/List/Tree zentral berechnen.
- Tree/List/Grid verwenden dieselbe Grundlage fuer Range-Auswahl und Rendering.

Neue oder erweiterte Module:

- `app/components/file-browser/useFileExplorerViewModel.ts`
- `app/components/file-browser/useFileExplorerSelectionHandlers.ts`

Regel:

- Hooks duerfen Store lesen und UI-orientierte Ableitungen liefern.
- Pure Tree-/Path-Mechanik bleibt in `app/lib/files/*`.
- Komponenten rendern nur noch die durch Hooks vorbereiteten Listen.

Verifikation:

- `npm run test:file-watcher`
- `npm run lint`
- `npm run build`
- Playwright/Browser-Pruefung nur nach Freigabe.

Commit:

- `Extract file explorer view model`

### Phase 5b: Item-Subscriptions verschlanken

Ziel:

- `FileTreeNode` und `FileGridItem` sollen nicht bei jeder Store-Aenderung breit neu rendern.
- Selection-/Loading-/Expanded-Zustand wird ueber gezielte primitive Selectors gelesen.
- Stabile Click-Handler reduzieren vermeidbare Re-Renders.

Regel:

- Keine UI-Umgestaltung.
- Keine neue Selection-Semantik.
- Verhalten muss in Tree/List/Grid gleich bleiben.

Verifikation:

- `npm run test:file-watcher`
- `npm run lint`
- `npm run build`

Commit:

- `Reduce file explorer item rerenders`

### Phase 5c: Action-Flows aus `FileActionsDropdown` ziehen

Ziel:

- `FileActionsDropdown` soll Menue und Dialoge rendern, nicht alle Operation-Flows selbst besitzen.
- Copy/Paste/Move/Delete/Rename-Auswertung wird in kleine Hooks verschoben.

Moegliche Module:

- `app/components/file-browser/useFileActionHandlers.ts`
- `app/components/file-browser/useFileDialogState.ts`

Regel:

- UI bleibt in Komponenten.
- Wiederverwendbare Ablaufmechanik kommt in Hooks.
- Server-Policy bleibt serverseitig.

Verifikation:

- `npm run test:file-watcher`
- `npm run test:workspace:cross-copy`
- `npm run lint`
- `npm run build`

Commit:

- `Extract file action handlers`

### Phase 6: API Boundary Helpers

Ziel:

- Wiederholte Auth/RateLimit/Error-Response-Muster reduzieren.
- Route Handler behalten ihre Produktpolicy.

Moegliche Module:

- `app/lib/api/route-helpers.ts`
- `app/lib/filesystem/workspace-cache-invalidation.ts`

Kandidaten:

- `requireApiSession`
- `parseJsonBody`
- `jsonError`
- `invalidateWorkspaceFileViews`

Regel:

- Kein zentraler God-Service.
- Kein Service, der heimlich Domain-State veraendert.
- Jede Route bleibt klar lesbar.

Verifikation:

- `npm run lint`
- `npm run build`
- relevante API-/Integrationstests, wenn vorhanden.

Commit:

- `Reduce repeated files API route boilerplate`

### Phase 7: Altlasten bewerten

Kandidaten:

- `app/components/file-browser/FileNode.tsx.backup`
- doppelte File Size Formatter
- direkte `useFileStore.setState` Calls in UI-Komponenten
- leere `catch {}` Bloecke bei Nutzeraktionen

Regel:

- Entfernen nur, wenn eindeutig ungenutzt und nach Verifikation.

Verifikation:

- `npm run lint`
- `npm run build`

Commit:

- nach konkretem Inhalt benennen.

## Teststrategie

Minimal pro Refactor-Commit:

- `npm run test:file-watcher`
- `npm run lint`
- `npm run build`

Bei UI-/Interaktionsaenderungen:

- Vorher fragen, ob Playwright/Browser-Pruefung ausgefuehrt werden soll.
- Dev Server nur auf `localhost:3000`.
- Keinen neuen Dev Server starten, falls auf Port 3000 schon einer laeuft.

Container:

- Kein Container-Build ohne explizite Aufforderung.
- Vor jedem Container-Testlauf muesste ein frischer Recreate/Rebuild erfolgen.
- Sicherstellen, dass nicht mehrere Test-Container parallel laufen.

## Commit-Plan

1. `Document file browser refactor plan` - done
2. `Extract file browser path and tree utilities` - done
3. `Extract file browser API client` - done
4. `Simplify file store tree operations` - partly done
5. `Consolidate file browser operation flows` - partly done
6. `Extract file explorer view model`
7. `Reduce file explorer item rerenders`
8. `Extract file action handlers`
9. `Reduce repeated files API route boilerplate`

Jeder Commit soll nur den abgeschlossenen Schritt enthalten. Fremde bestehende Aenderungen im Arbeitsbaum werden nicht gestaged.
