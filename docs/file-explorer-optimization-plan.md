# File Explorer Optimierung - Architektur-Plan

## Kontext & Motivation

Der aktuelle File Explorer funktioniert, hat aber architektonische Schwaechen, die bei wachsenden Workspaces Probleme verursachen:

- **Kein Lazy Loading**: `buildFileTree('.', 4)` laedt rekursiv bis Tiefe 4 auf einen Schlag
- **Globaler Cache-Invalidation**: Jede Dateiaenderung loescht den gesamten Tree-Cache
- **Kein Copy**: Rename/Move existiert, aber Copy fehlt komplett
- **Kein Batch Delete**: Dateien werden einzeln geloescht, obwohl Multi-Select existiert
- **Singleton File Watcher**: Startet sofort rekursiv bis Tiefe 10, nicht stoppbar, nicht referenzgezaehlt
- **Doppelter Tree-Fetch**: `loadFileTree` fetcht bei Subdirectory-Navigation den Tree zweimal
- **FileContextMenu pro Node**: Jeder FileTreeNode mountet eine eigene Menu+Dialog-Instanz (DOM-Bloat)
- **multiSelectPaths ist Array statt Set**: O(n)-Lookup pro Node, O(n²) fuer den ganzen Baum
- **Depth-Default zu hoch**: Mindestens 10 Ebenen tief, auch wenn nur Root geladen wird
- **Duplizierter Code**: Navigation-Block in FileBrowser und `findPathInTree` doppelt implementiert
- **window.dispatchEvent als Kommunikation**: Custom Events umgehen State-Management komplett

---

## Umsetzungsreihenfolge

Jeder Schritt wird einzeln getestet (`npm run build` + manuelle UI-Pruefung) bevor der naechste begonnen wird.

### Phase 0: Quick Fixes (Bugs & Code-Qualitaet)

Sofort umsetzbare Verbesserungen ohne architektonische Aenderungen. Behebt bestehende Bugs und Performance-Probleme.

#### 0.1 — Doppelten Tree-Fetch in `loadFileTree` entfernen

`file-store.ts:183-200`: Wenn `activeDir !== '.'`, wird der Tree zweimal gefetcht — einmal fuer den Subtree, dann nochmal von Root. Der erste Fetch ist komplett verschwendet.

```ts
// VORHER (file-store.ts:183-200):
if (activeDir === '.') {
  set({ fileTree: data, isLoadingTree: false });
} else {
  // Holt NOCHMAL alles von Root — erster Fetch war umsonst
  const rootUrl = `/api/files/tree?path=.&depth=...`;
  const rootResponse = await fetch(rootUrl, ...);
}

// NACHHER: Immer von Root laden, nur einmal fetchen
const url = `/api/files/tree?path=.&depth=${depthTarget}`;
const response = await fetch(url, ...);
set({ fileTree: data, isLoadingTree: false });
```

#### 0.2 — Depth-Default von 10 auf 4 reduzieren

`file-store.ts:160-165`: `Math.max(10, ...)` laedt immer mindestens 10 Ebenen. Das ist unnoetig und wird durch Lazy Loading (Phase 1) ersetzt.

```ts
// VORHER:
const depthTarget = typeof depth === 'number'
  ? depth
  : Math.max(10, ...);

// NACHHER:
const depthTarget = typeof depth === 'number' ? depth : 4;
```

#### 0.3 — `multiSelectPaths` von `string[]` auf `Set<string>` umstellen

`file-store.ts:130` + `FileTreeNode.tsx:43`: Array mit `.includes()` ist O(n) pro Node. Bei 200 Nodes im Baum ist das O(n²). Set hat O(1) Lookup.

```ts
// VORHER (file-store.ts):
multiSelectPaths: string[];

// FileTreeNode.tsx:
const isMultiSelected = multiSelectPaths.includes(node.path);  // O(n)

// NACHHER (file-store.ts):
multiSelectPaths: Set<string>;

// FileTreeNode.tsx:
const isMultiSelected = multiSelectPaths.has(node.path);  // O(1)
```

Alle Stellen die `multiSelectPaths` lesen/schreiben muessen angepasst werden:
- `file-store.ts`: `toggleMultiSelectPath`, `selectRange`, `selectAllInDirectory`, `clearMultiSelect`
- `FileBrowser.tsx`: `.length` -> `.size`, `.filter()` -> Iteration, `.some()` -> Iteration
- `FileContextMenu.tsx`: `.length` -> `.size`, `.some()` -> Iteration

#### 0.4 — FileContextMenu auf FileBrowser-Ebene heben

`FileTreeNode.tsx:152/212`: Jeder Node rendert eine eigene `FileContextMenu`-Instanz mit 5 Dialog-Komponenten (Create, Delete, Rename, Move, Share). Bei 200 Dateien sind das 200×5 = 1000 Dialog-Instanzen im DOM.

```tsx
// VORHER (FileTreeNode.tsx) — in JEDEM Node:
<FileContextMenu node={node} isRowActive={isRowActive} />

// NACHHER: Eine einzige Instanz auf FileBrowser-Ebene
// FileTreeNode oeffnet per Store-Action nur das Menu:
const { openContextMenu } = useFileStore();
onContextMenu={() => openContextMenu(node)}

// FileBrowser.tsx — eine einzige Instanz:
<FileContextMenu />  // liest Ziel-Node aus Store
```

Neuer Store-State:
```ts
contextMenuNode: FileNode | null;
openContextMenu: (node: FileNode) => void;
closeContextMenu: () => void;
```

#### 0.5 — Duplizierten Navigation-Block zusammenfuehren

`FileBrowser.tsx:459-522`: Der Root/Up-Button-Block ist identisch fuer mobile und desktop dupliziert.

```tsx
// VORHER: Zwei identische Bloecke mit unterschiedlicher Bedingung
{(isMobile || isMobileSheet) && ( <div>...</div> )}
{!isMobile && !isMobileSheet && ( <div>...</div> )}

// NACHHER: Ein Block, immer gerendert
<div className="border-t border-border bg-muted/30 px-3 py-2">
  {/* Root-Button, Up-Button, Directory-Label */}
</div>
```

#### 0.6 — `findPathInTree` deduplizieren

`FileBrowser.tsx:81-86` und `file-store.ts:137-144`: Exakt dieselbe Funktion an zwei Stellen.

```ts
// NACHHER: Eine Hilfsfunktion in file-store.ts exportieren
export function findPathInTree(searchPath: string, tree: FileNode[]): boolean {
  if (searchPath === '.') return true;
  for (const node of tree) {
    if (node.path === searchPath) return true;
    if (node.children && findPathInTree(searchPath, node.children)) return true;
  }
  return false;
}

// FileBrowser.tsx importiert sie
```

#### 0.7 — Leeren `handleFileEvent` Callback entfernen

`FileBrowser.tsx:50-52`: Der `onEvent`-Callback loggt nur und tut sonst nichts. Der Reload passiert im Hook selbst.

```ts
// VORHER:
const handleFileEvent = useCallback((event: FileEvent) => {
  console.log('[FileBrowser] File change event:', event);
}, []);

const { isConnected } = useFileWatcher({
  onEvent: handleFileEvent,
  ...
});

// NACHHER:
const { isConnected } = useFileWatcher({
  enabled: true,
  debounceMs: 1000,
  maxDebounceMs: 5000,
});
```

#### 0.8 — `window.dispatchEvent(CustomEvent)` durch Store-Actions ersetzen

`FileTreeNode.tsx:63-71` und `FileBrowser.tsx:218`: Custom Events ueber `window` als Inter-Komponenten-Kommunikation umgehen das State-Management.

```ts
// VORHER (FileTreeNode.tsx):
window.dispatchEvent(new CustomEvent('notebook-mobile-file-opened', ...));
window.dispatchEvent(new CustomEvent('notebook-mobile-surface', ...));

// VORHER (FileBrowser.tsx):
window.dispatchEvent(new CustomEvent('notebook-bulk-move-open'));

// NACHHER: Store-Actions oder Callbacks
// Neuer Store-State (z.B. in einem UI-Store):
mobileSurface: 'files' | 'editor' | null;
setMobileSurface: (surface: string) => void;
bulkMoveOpen: boolean;
setBulkMoveOpen: (open: boolean) => void;
```

Hinweis: Vor dem Umbau pruefen welche Listener auf diese Events hoeren und sicherstellen dass die Store-Alternative sie alle abdeckt.

| # | Task | Dateien | Abhaengigkeiten | Status |
|---|------|---------|-----------------|--------|
| 0.1 | Doppelten Tree-Fetch entfernen | `app/store/file-store.ts` | - | **Done** |
| 0.2 | Depth-Default auf 4 reduzieren | `app/store/file-store.ts` | - | **Done** |
| 0.3 | `multiSelectPaths` auf `Set<string>` umstellen | `app/store/file-store.ts`, `FileTreeNode.tsx`, `FileBrowser.tsx`, `FileContextMenu.tsx`, `BulkMoveDialog.tsx` | - | **Done** |
| 0.4 | FileContextMenu auf FileBrowser-Ebene heben | `FileTreeNode.tsx`, `FileTree.tsx`, `FileContextMenu.tsx`, `app/store/file-store.ts` | - | **Done** |
| 0.5 | Duplizierten Navigation-Block zusammenfuehren | `app/components/file-browser/FileBrowser.tsx` | - | **Done** |
| 0.6 | `findPathInTree` deduplizieren | `app/store/file-store.ts`, `app/components/file-browser/FileBrowser.tsx` | - | **Done** |
| 0.7 | Leeren `handleFileEvent` Callback entfernen | `app/components/file-browser/FileBrowser.tsx` | - | **Done** |
| 0.8 | `window.dispatchEvent` durch Store-Actions ersetzen | `FileTreeNode.tsx`, `FileBrowser.tsx`, `BulkMoveDialog.tsx`, `DashboardShell.tsx`, `CanvasAgentChat.tsx` | 0.4 | **Done** |

---

### Phase 1: Lazy Loading (Subtree on Expand)

Groesster Performance-Gewinn. Statt den gesamten Baum rekursiv zu laden, wird nur die oberste Ebene geladen und Unterverzeichnisse werden bei Bedarf nachgeladen.

#### Tree Endpoint Erweiterung

```ts
// GET /api/files/tree?path=.&depth=0
// Liefert nur die oberste Ebene (keine Rekursion)

// GET /api/files/tree?path=src/components&depth=1
// Liefert nur den Subtree ab subPath, eine Ebene tief
```

Der bestehende `depth`-Parameter in [tree/route.ts](app/api/files/tree/route.ts) wird genutzt - der Client sendet kuenftig `depth=0` fuer den initialen Load und `depth=1` beim Aufklappen eines Verzeichnisses.

#### Store-Aenderungen

```ts
// Statt rekursivem loadFileTree('.', 4):

// 1. Initial Load: Nur Root-Verzeichnisse (Tiefe 0)
loadFileTree('.', 0)  // Nur die oberste Ebene

// 2. On Expand: Unterverzeichnis nachladen
async toggleDirectory(dirPath: string) {
  if (this.expandedDirs.has(dirPath)) {
    this.expandedDirs.delete(dirPath)
    return
  }

  this.expandedDirs.add(dirPath)

  // Pruefe ob Kinder bereits geladen
  const node = this.findNodeInTree(dirPath)
  if (!node?.children || node.children.length === 0) {
    // Lazy Load: Nur dieses Unterverzeichnis
    await this.loadSubdirectory(dirPath)
  }
}

// 3. Cache: Geladene Unterverzeichnisse bleiben im Tree
// Ein Refresh aktualisiert nur sichtbare (expanded) Verzeichnisse
```

| # | Task | Dateien | Abhaengigkeiten | Status |
|---|------|---------|-----------------|--------|
| 1.1 | Client auf `depth=0` fuer initialen Load umstellen | `app/store/file-store.ts`, `FileTree.tsx` | 0.1, 0.2 | **Done** |
| 1.2 | `toggleDirectory` mit Lazy-Load implementieren | `app/store/file-store.ts` | 1.1 | **Done** |
| 1.3 | `loadSubdirectory` mit subPath-Request | `app/store/file-store.ts` | 1.1 | **Done** |
| 1.4 | FileTreeNode: Loading-State beim Expand anzeigen | `app/components/file-browser/FileTreeNode.tsx` | 1.2 | **Done** |

---

### Phase 2: Per-Subtree Cache Invalidation + SSE mit Pfad-Info

Behebt das globale `clearFileTreeCache()` Problem. Statt bei jeder Dateiaenderung den gesamten Cache zu loeschen, wird nur der betroffene Subtree invalidiert. Behebt ausserdem das Problem dass `useFileWatcher` den Event-Pfad kennt aber ignoriert.

#### Per-Subtree Cache Invalidation

```ts
// Statt globaler Cache-Clear bei jeder Aenderung:

// Nur das betroffene Unterverzeichnis invalidieren
clearSubtreeCache(dirPath: string): void {
  // LRU Cache: { '/src/components': treeData, '/src/utils': treeData, ... }
  // Nur den Eintrag fuer dirPath entfernen
  // Parent-Eintraege die dirPath enthalten ebenfalls invalidieren
  for (const key of this.cache.keys()) {
    if (key === dirPath || key.startsWith(dirPath + '/') || dirPath.startsWith(key + '/')) {
      this.cache.delete(key)
    }
  }
}
```

#### SSE Events mit Pfad-Info

```ts
// SSE Event erweitert:
// { type: 'file-change', path: '/src/components/Button.tsx', dir: '/src/components' }
// Client: "Ich habe /src/components expanded" -> lade nur dieses Subtree neu
// Client: "Ich habe /src/components nicht expanded" -> ignoriere
```

#### useFileWatcher: Event-Pfad nutzen statt ignorieren

```ts
// VORHER (useFileWatcher.ts:113):
// Kennt event.relativePath, laedt aber trotzdem alles von Root
loadFileTree('.', undefined, true);

// NACHHER: Parent-Verzeichnis der geaenderten Datei als Reload-Target
const parentDir = event.relativePath.includes('/')
  ? event.relativePath.substring(0, event.relativePath.lastIndexOf('/'))
  : '.';
loadSubdirectory(parentDir);
```

| # | Task | Dateien | Abhaengigkeiten | Status |
|---|------|---------|-----------------|--------|
| 2.1 | `clearFileTreeCache()` durch `clearSubtreeCache(dirPath)` ersetzen | `app/lib/utils/file-tree-cache.ts`, `app/lib/utils/lru-cache.ts` | - | **Done** |
| 2.2 | File Watcher: `dir`-Feld in SSE Events mitsenden | `app/lib/filesystem/file-watcher.ts` | - | **Done** |
| 2.3 | `useFileWatcher`: Event-Pfad fuer gezielten Subtree-Reload nutzen | `app/hooks/useFileWatcher.ts` | 1.3, 2.1, 2.2 | **Done** |

---

### Phase 3: Copy-Endpoint + UI

Fehlende Kernfunktion. Direkt auf `workspace-files.ts` aufgebaut, kein VFS noetig.

#### Copy Endpoint

```ts
// POST /api/files/copy
// Request:
{
  "sources": ["/path/to/file1.md", "/path/to/folder1"],
  "destDir": "/path/to/destination",
  "overwrite": false
}

// Response:
{
  "success": true,
  "copied": ["/path/to/destination/file1.md", "/path/to/destination/folder1"],
  "failed": [],
  "skipped": []  // wenn overwrite=false und Ziel existiert
}
```

#### Copy-Funktion in workspace-files.ts

```ts
// Neue Funktion in workspace-files.ts
export async function copyFile(
  sourcePath: string,
  destDir: string,
  overwrite = false
): Promise<{ copied: string; skipped: boolean }> {
  const fullSource = validatePath(sourcePath)
  const fullDestDir = validatePath(destDir)
  const fileName = path.basename(sourcePath)
  const fullDest = path.join(fullDestDir, fileName)

  // Prüfe ob Ziel existiert
  try {
    await fs.access(fullDest)
    if (!overwrite) {
      return { copied: '', skipped: true }
    }
  } catch {
    // Ziel existiert nicht - gut
  }

  // Kopiere (rekursiv fuer Verzeichnisse)
  await fs.cp(fullSource, fullDest, { recursive: true })
  return { copied: path.join(destDir, fileName), skipped: false }
}
```

#### Kontextmenue Erweiterung

```tsx
// FileContextMenu.tsx - Neue Eintraege:
// - Kopieren (Copy) -> setzt ClipboardState
// - Einfuegen (Paste) -> ruft /api/files/copy auf
// - Duplizieren (Duplicate) -> Copy im selben Verzeichnis
```

| # | Task | Dateien | Abhaengigkeiten | Status |
|---|------|---------|-----------------|--------|
| 3.1 | `copyFile()` + `batchCopy()` in workspace-files.ts | `app/lib/filesystem/workspace-files.ts` | - | **Done** |
| 3.2 | Copy API Route | `app/api/files/copy/route.ts` | 3.1 | **Done** |
| 3.3 | ClipboardState im Store | `app/store/file-store.ts` | - | **Done** |
| 3.4 | Kontextmenue: Copy/Paste/Duplicate | `app/components/file-browser/FileContextMenu.tsx`, `messages/en.json`, `messages/de.json` | 3.2, 3.3 | **Done** |

---

### Phase 4: Batch Delete

Ergaenzt Multi-Select sinnvoll. Statt N einzelne DELETE-Requests wird ein Batch-Request gesendet.

#### Batch Delete Endpoint

```ts
// DELETE /api/files/delete
// Request:
{
  "paths": ["/path/to/file1.md", "/path/to/folder1", "/path/to/file2.ts"]
}

// Response:
{
  "success": true,
  "deleted": ["/path/to/file1.md", "/path/to/folder1"],
  "failed": [{ "path": "/path/to/file2.ts", "error": "Permission denied" }]
}

// Jeden Pfad einzeln mit validatePath() pruefen
// Geschuetzte Pfade (app-output-folders) werden automatisch gefiltert
// Parallele Ausfuehrung mit Promise.allSettled
```

| # | Task | Dateien | Abhaengigkeiten | Status |
|---|------|---------|-----------------|--------|
| 4.1 | Batch Delete in workspace-files.ts | `app/lib/filesystem/workspace-files.ts` | - | **Done** |
| 4.2 | Delete API Route auf Batch umstellen | `app/api/files/delete/route.ts` | 4.1 | **Done** |
| 4.3 | Client auf Batch Delete umstellen | `app/store/file-store.ts` | 4.2 | **Done** |

---

### Phase 5: Reference-Counted File Watcher

Behebt das Singleton-Problem. Statt beim Import sofort alles rekursiv zu watchen, wird nur beobachtet was Clients tatsaechlich sehen.

#### Reference-Counted Subscriptions

```ts
class FileWatcherService {
  private subscriptions = new Map<string, Set<string>>()  // path -> Set<clientId>
  private watchers = new Map<string, FSWatcher>()

  subscribe(clientId: string, dirPath: string): void {
    if (!this.subscriptions.has(dirPath)) {
      this.subscriptions.set(dirPath, new Set())
    }
    const subs = this.subscriptions.get(dirPath)!

    if (subs.size === 0) {
      // Erster Subscriber -> fs.watch starten
      this.startWatching(dirPath)
    }

    subs.add(clientId)
  }

  unsubscribe(clientId: string, dirPath: string): void {
    const subs = this.subscriptions.get(dirPath)
    if (!subs) return

    subs.delete(clientId)

    if (subs.size === 0) {
      // Letzter Subscriber -> fs.watch stoppen
      this.stopWatching(dirPath)
    }
  }

  unsubscribeAll(clientId: string): void {
    // Beim Disconnect: alle Subscriptions des Clients entfernen
    for (const [dirPath, subs] of this.subscriptions) {
      subs.delete(clientId)
      if (subs.size === 0) this.stopWatching(dirPath)
    }
  }
}
```

| # | Task | Dateien | Abhaengigkeiten | Status |
|---|------|---------|-----------------|--------|
| 5.1 | FileWatcher auf Reference-Counting umbauen | `app/lib/filesystem/file-watcher.ts` | - | **Done** |
| 5.2 | SSE Watch Route: subscribe/unsubscribe per expanded Dir | `app/api/files/watch/route.ts` | 5.1 | **Done** |
| 5.3 | Client: expanded Dirs an Watcher melden | `app/store/file-store.ts` | 5.2, 1.2 | **Done** |

---

### Phase 6: UX-Polish

#### Breadcrumb Navigation

```tsx
function FileBreadcrumb({ path }: { path: string }) {
  const segments = path.split('/').filter(Boolean)
  return (
    <nav className="flex items-center gap-1 text-sm px-2 py-1">
      <button onClick={() => navigateTo('.')}><Home size={14} /></button>
      {segments.map((segment, i) => (
        <Fragment key={i}>
          <ChevronRight size={12} className="text-muted-foreground" />
          <button onClick={() => navigateTo(segments.slice(0, i + 1).join('/'))}>
            {segment}
          </button>
        </Fragment>
      ))}
    </nav>
  )
}
```

| # | Task | Dateien | Abhaengigkeiten | Status |
|---|------|---------|-----------------|--------|
| 6.1 | Breadcrumb Navigation | `app/components/file-browser/FileBreadcrumb.tsx` | 1.2 | **Done** |

---

## Sicherheits-Betrachtungen

### Beibehalten
- `validatePath()` Path Traversal Protection
- Auth via better-auth in jedem API Route
- Rate Limiting
- Upload Filename Sanitization
- Protected App Output Folders

### Neu hinzufuegen
- Copy Endpoint: Selbe `validatePath()` Pruefung fuer Source und Destination
- Batch Delete: Jeden Pfad einzeln validieren bevor Loeschen

---

## Nicht-Ziele (Out of Scope)

- VFS-Abstraktion / Plugin-System (kein zweiter Filesystem-Treiber geplant)
- Virtual Scroll (erst bei konkreten Rendering-Problemen nachrüsten)
- Hash-basiertes Diffing (SSE + gezieltes Subtree-Reload reicht)
- Chunked Upload / Resume (Upload-Limit ist 10MB, nicht noetig)
- Transfer Store / Progress UI (Sub-Sekunden-Uploads brauchen kein Progress-Tracking)
- Optimistic Updates (Self-Hosted App mit geringer Latenz, Aufwand ueberwiegt Nutzen)
- WebSocket statt SSE
- FTP/S3/SFTP Plugins
- Datei-Versionsverwaltung / History
- Datei-Berechtigungen aendern (nur anzeigen)
- Suchfunktion innerhalb von Dateiinhalten
- Recycling-Bin / Trash (Deletion bleibt permanent)
