import 'server-only';

import { createHash } from 'node:crypto';
import { constants, writeFileSync, type Stats } from 'node:fs';
import fs, { type FileHandle } from 'node:fs/promises';
import path from 'node:path';

import { filesystemFileVersion } from '../filesystem/file-version';
import type { WorkspaceType } from './types';

export const WORKSPACE_STARTER_DOCUMENT_NAME = 'Erste Schritte.md';

function workspaceIntroduction(workspaceType: WorkspaceType): string {
  if (workspaceType === 'personal') {
    return `## Dein persönlicher Workspace

Dieser Workspace ist dein privater Arbeitsbereich. Hier kannst du eigene Notizen, Entwürfe, Dateien und Ideen sammeln und sie gemeinsam mit Bradley weiterentwickeln.`;
  }

  if (workspaceType === 'team') {
    return `## Euer Team-Workspace

Dieser Workspace ist ein gemeinsamer Arbeitsbereich für euer Team. Alle Mitglieder sehen nur die Inhalte, für die sie berechtigt sind. Nutzt klare Ordner, verständliche Dateinamen und @Mentions, damit Zusammenarbeit und Übergaben nachvollziehbar bleiben.`;
  }

  if (workspaceType === 'organization') {
    return `## Euer Organisations-Workspace

Dieser Workspace bündelt Wissen und Arbeitsmaterialien, die in der Organisation gemeinsam genutzt werden. Berechtigungen steuern, wer Inhalte lesen, bearbeiten oder verwalten darf.`;
  }

  return `## Euer Projekt-Workspace

Dieser Workspace gehört zu einem Projekt. Hier bleiben Projektwissen, Dateien, Aufgaben und die Arbeit mit Bradley in einem klar abgegrenzten gemeinsamen Kontext.`;
}

function workspaceChecklist(workspaceType: WorkspaceType): string {
  if (workspaceType === 'personal') {
    return `- [ ] Schreibe unter diese Liste eine erste private Notiz
- [ ] Bitte Bradley, die Notiz zu strukturieren oder zusammenzufassen`;
  }

  return `- [ ] Legt eine einfache Ordnerstruktur für eure Zusammenarbeit an
- [ ] Verwendet eine @Mention, um ein Teammitglied in einem Dokument anzusprechen`;
}

export function createWorkspaceStarterDocument(workspaceType: WorkspaceType): string {
  const isPersonal = workspaceType === 'personal';
  const opening = isPersonal
    ? 'Dieses Dokument ist dein kurzer Einstieg und gleichzeitig eine sichere Spielwiese. Du kannst alles darin verändern, umbenennen oder löschen.'
    : 'Dieses Dokument ist euer kurzer Einstieg und gleichzeitig eine sichere Spielwiese. Ihr könnt alles darin verändern, umbenennen oder löschen.';
  const closing = isPersonal
    ? 'Passe die Struktur an deine Arbeit an.'
    : 'Passt die Struktur an eure Zusammenarbeit an.';

  return `# Willkommen bei Canvas Notebook 👋

${opening} Änderungen werden automatisch gespeichert; gelöschte Dateien lassen sich über den Papierkorb beziehungsweise direkt nach dem Löschen wiederherstellen.

${workspaceIntroduction(workspaceType)}

## In zwei Minuten loslegen

${workspaceChecklist(workspaceType)}
- [ ] In einer leeren Zeile \`/\` tippen und einen Block einfügen
- [ ] Text markieren und **Fett**, *Kursiv*, ~~Durchgestrichen~~, \`Inline-Code\` oder ==Highlight== ausprobieren
- [ ] Ein weiteres Markdown-Dokument erstellen und mit \`[[Dokumentname]]\` verlinken
- [ ] In den To-dos eine Aufgabe mit Bezug zu einer Datei anlegen
- [ ] Zum Abschluss dieses Dokument umbenennen oder löschen

> [!tip] Arbeite direkt mit Bradley
> Öffne den Chat im Notebook, beschreibe dein Ziel und verweise auf die aktuelle Datei. Je nach Berechtigung kann Bradley Inhalte analysieren, neue Dateien anlegen oder konkrete Änderungen zur Übernahme vorschlagen.

## Dokumente bearbeiten

Der Markdown-Editor unterstützt unter anderem:

- Überschriften, Listen, Checklisten, Zitate und Codeblöcke
- Tabellen, Formeln, Fußnoten, Callouts und aufklappbare Bereiche
- Bilder aus einer Datei oder von einer URL
- Wiki-Links zwischen Dokumenten und eingebettete Markdown-Dokumente
- einen Quelltextmodus für die direkte Bearbeitung des Markdown-Inhalts
- gemeinsames Bearbeiten unterstützter Dokumente in geteilten Workspaces

Ziehe Blöcke am Griff an der linken Seite, um sie neu anzuordnen. Mit \`/\` findest du die verfügbaren Blöcke besonders schnell.

## Dateien und weitere Werkzeuge

Im Dateibereich kannst du Ordner anlegen sowie Dateien hochladen, verschieben, kopieren, umbenennen, herunterladen und löschen. Canvas zeigt neben Markdown auch Bilder, PDFs, Office-Dokumente, Tabellen, Präsentationen, Audio, Video und viele Codeformate direkt an.

- **To-dos** halten nächste Schritte, Zuständigkeiten, Prioritäten und Fälligkeiten fest.
- **Automationen** führen wiederkehrende oder zeitgesteuerte Arbeit aus.
- **Terminal** bietet direkten Kommandozeilenzugriff auf den Workspace.
- **Einstellungen** verwalten Workspace-Mitglieder, Bradley, Provider, Tools und Integrationen.
- **Hilfe** enthält ausführlichere Anleitungen.

## Eine gute Grundstruktur

Du kannst zum Beispiel so beginnen:

\`\`\`text
Projekte/
Wissen/
Vorlagen/
Archiv/
\`\`\`

${closing} Dieses Startdokument ist nur ein Vorschlag und darf jederzeit verschwinden.
`;
}

export function seedWorkspaceStarterDocument(input: {
  rootPath: string;
  workspaceType: WorkspaceType;
}): 'created' | 'existing' {
  const documentPath = path.join(input.rootPath, WORKSPACE_STARTER_DOCUMENT_NAME);

  try {
    writeFileSync(documentPath, createWorkspaceStarterDocument(input.workspaceType), {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    });
    return 'created';
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST') {
      return 'existing';
    }
    throw error;
  }
}

export const WORKSPACE_STARTER_MAX_BYTES = 5 * 1024 * 1024;
export type WorkspaceStarterDocumentFacts = Readonly<{
  path: typeof WORKSPACE_STARTER_DOCUMENT_NAME;
  seedDisposition: 'created' | 'existing';
  sourceFileVersion: string;
  sourceSha256: string;
  sourceBytes: number;
}>;
declare const observedStarter: unique symbol;
/** A held original descriptor, never an Auth, native-write or SQL grant. */
export type ObservedWorkspaceStarterDocument = Readonly<{ [observedStarter]: true }>;
type DirectoryPin = { path: string; handle: FileHandle; dev: number; ino: number };
type Observation = { active: boolean; handle: FileHandle; directories: DirectoryPin[]; filePath: string;
  facts: WorkspaceStarterDocumentFacts; failure?: Error; pending: Set<Promise<void>> };
const observations = new WeakMap<ObservedWorkspaceStarterDocument, Observation>();

export class WorkspaceStarterDocumentError extends Error {
  readonly status: number;
  constructor(readonly code: 'invalid-source' | 'source-changed' | 'source-too-large' | 'observation-closed' | 'disposal-unconfirmed', options?: ErrorOptions) {
    super(code, options); this.name = 'WorkspaceStarterDocumentError'; this.status = code === 'disposal-unconfirmed' ? 503 : 409;
  }
}
function starterFailure(code: WorkspaceStarterDocumentError['code']): never { throw new WorkspaceStarterDocumentError(code); }
function safeFile(stat: Stats): void {
  if (!stat.isFile() || stat.nlink !== 1 || ![stat.dev, stat.ino, stat.size].every(Number.isSafeInteger)
    || stat.dev < 0 || stat.ino < 0 || stat.size < 0 || !Number.isFinite(stat.mtimeMs) || !Number.isFinite(stat.ctimeMs)) starterFailure('invalid-source');
  if (stat.size > WORKSPACE_STARTER_MAX_BYTES) starterFailure('source-too-large');
}
async function exactEntry(parent: string, name: string): Promise<boolean> {
  const directory = await fs.opendir(parent);
  try { for (let entry = await directory.read(); entry; entry = await directory.read()) if (entry.name === name) return true;
    return false;
  } finally { await directory.close(); }
}
async function assertDirectories(pins: readonly DirectoryPin[]): Promise<void> {
  for (const pin of pins) {
    const named = await fs.lstat(pin.path), held = await pin.handle.stat();
    if (!named.isDirectory() || named.isSymbolicLink() || !held.isDirectory()
      || named.dev !== pin.dev || named.ino !== pin.ino || held.dev !== pin.dev || held.ino !== pin.ino) starterFailure('source-changed');
  }
}
async function hashStarter(handle: FileHandle, expected: Stats): Promise<string> {
  safeFile(expected);
  const hash = createHash('sha256'), buffer = Buffer.alloc(64 * 1024); let offset = 0;
  while (offset <= expected.size) {
    const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, expected.size + 1 - offset), offset);
    if (!bytesRead) break;
    offset += bytesRead; if (offset > expected.size) starterFailure('source-changed');
    hash.update(buffer.subarray(0, bytesRead));
  }
  const after = await handle.stat(); safeFile(after);
  if (offset !== expected.size || filesystemFileVersion(after) !== filesystemFileVersion(expected)) starterFailure('source-changed');
  return hash.digest('hex');
}
async function assertObservation(stage: Observation): Promise<void> {
  if (!stage.active) starterFailure('observation-closed');
  await assertDirectories(stage.directories);
  if (!await exactEntry(path.dirname(stage.filePath), WORKSPACE_STARTER_DOCUMENT_NAME)) starterFailure('source-changed');
  const named = await fs.lstat(stage.filePath), held = await stage.handle.stat(); safeFile(named); safeFile(held);
  if (named.isSymbolicLink() || filesystemFileVersion(named) !== stage.facts.sourceFileVersion
    || filesystemFileVersion(held) !== stage.facts.sourceFileVersion) starterFailure('source-changed');
  if (await hashStarter(stage.handle, held) !== stage.facts.sourceSha256) starterFailure('source-changed');
  await assertDirectories(stage.directories);
  const final = await fs.lstat(stage.filePath); safeFile(final);
  if (filesystemFileVersion(final) !== stage.facts.sourceFileVersion || !stage.active) starterFailure('source-changed');
}
function activeObservation(observation: ObservedWorkspaceStarterDocument): Observation {
  const stage = observations.get(observation);
  if (!stage?.active) starterFailure('observation-closed');
  if (stage.failure) throw stage.failure;
  return stage;
}
export function readObservedWorkspaceStarterDocument(observation: ObservedWorkspaceStarterDocument): WorkspaceStarterDocumentFacts {
  return activeObservation(observation).facts;
}
export async function assertObservedWorkspaceStarterDocumentCurrent(observation: ObservedWorkspaceStarterDocument): Promise<void> {
  const stage = activeObservation(observation);
  const pending = assertObservation(stage).catch(error => {
    stage.failure ??= error instanceof Error ? error : new Error('Starter observation failed.', { cause: error }); throw stage.failure;
  });
  stage.pending.add(pending);
  try { await pending; } finally { stage.pending.delete(pending); }
}

/** Seed and observe the actual original bytes while the caller records its
 * expectation. All directory/file descriptors remain held until it returns.
 * Later admission must independently revalidate these historical facts. */
export async function withObservedWorkspaceStarterDocument<T>(input: { rootPath: string; workspaceType: WorkspaceType },
  operation: (observation: ObservedWorkspaceStarterDocument) => Promise<T>): Promise<T> {
  const { rootPath, workspaceType } = input;
  if (typeof rootPath !== 'string' || !path.isAbsolute(rootPath) || path.resolve(rootPath) !== rootPath
    || rootPath.length > 4096 || /[\\\u0000-\u001f\u007f]/u.test(rootPath) || rootPath.split(path.sep).length > 64
    || !['personal', 'team', 'organization', 'project'].includes(workspaceType) || typeof operation !== 'function') starterFailure('invalid-source');
  const directories: DirectoryPin[] = []; let handle: FileHandle | undefined, stage: Observation | undefined;
  let failed = false, failure: unknown, value: T | undefined;
  try {
    let current = path.parse(rootPath).root;
    for (const segment of ['', ...rootPath.slice(current.length).split(path.sep).filter(Boolean)]) {
      if (segment) { if (!await exactEntry(current, segment)) starterFailure('source-changed'); current = path.join(current, segment); }
      const before = await fs.lstat(current);
      if (!before.isDirectory() || before.isSymbolicLink() || !Number.isSafeInteger(before.dev) || !Number.isSafeInteger(before.ino)) starterFailure('invalid-source');
      const directory = await fs.open(current, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      directories.push({ path: current, handle: directory, dev: before.dev, ino: before.ino });
      await assertDirectories(directories);
    }
    const filePath = path.join(rootPath, WORKSPACE_STARTER_DOCUMENT_NAME);
    let disposition: 'created' | 'existing' = 'created';
    try { handle = await fs.open(filePath, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); }
    catch (error) {
      if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'EEXIST') throw error;
      disposition = 'existing';
      if (!await exactEntry(rootPath, WORKSPACE_STARTER_DOCUMENT_NAME)) starterFailure('source-changed');
      const before = await fs.lstat(filePath); safeFile(before);
      handle = await fs.open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      if (filesystemFileVersion(await handle.stat()) !== filesystemFileVersion(before)) starterFailure('source-changed');
    }
    const generated = disposition === 'created' ? createWorkspaceStarterDocument(workspaceType) : undefined;
    if (generated !== undefined) await handle.writeFile(generated, 'utf8');
    const before = await handle.stat(); safeFile(before);
    const facts = Object.freeze({ path: WORKSPACE_STARTER_DOCUMENT_NAME, seedDisposition: disposition,
      sourceFileVersion: filesystemFileVersion(before), sourceSha256: await hashStarter(handle, before), sourceBytes: before.size });
    if (generated !== undefined && facts.sourceSha256 !== createHash('sha256').update(generated, 'utf8').digest('hex')) starterFailure('source-changed');
    stage = { active: true, handle, directories, filePath, facts, pending: new Set() };
    const observation = Object.freeze({}) as ObservedWorkspaceStarterDocument; observations.set(observation, stage);
    await assertObservedWorkspaceStarterDocumentCurrent(observation);
    value = await operation(observation);
    await assertObservedWorkspaceStarterDocumentCurrent(observation);
  } catch (error) { failed = true; failure = error; }
  finally {
    if (stage) {
      await Promise.allSettled([...stage.pending]); stage.active = false;
      if (!failed && stage.failure) { failed = true; failure = stage.failure; }
    }
    const errors: unknown[] = [];
    for (const descriptor of [...(handle ? [handle] : []), ...directories.map(pin => pin.handle).reverse()]) {
      try { await descriptor.close(); } catch (error) { errors.push(error); }
    }
    if (errors.length) throw new WorkspaceStarterDocumentError('disposal-unconfirmed', {
      cause: new AggregateError(failed ? [failure, ...errors] : errors, 'Starter descriptors were not confirmed closed.') });
  }
  if (failed) throw failure;
  return value as T;
}
