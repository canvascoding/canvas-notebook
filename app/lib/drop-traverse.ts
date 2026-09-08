import { WORKSPACE_UPLOAD_MAX_FILES, WORKSPACE_UPLOAD_MAX_FILE_BYTES, WORKSPACE_UPLOAD_MAX_TOTAL_BYTES } from './files/upload-limits';

export interface DroppedFile { file: File; relativePath: string }
export interface DropCollectionProgress { files: number; directories: number; bytes: number }
export interface DropCollectionOptions {
  signal?: AbortSignal;
  onProgress?: (progress: DropCollectionProgress) => void;
  timeoutMs?: number;
}
export interface DroppedItems { files: DroppedFile[]; emptyDirectories: string[] }
export const MAX_DROP_DIRECTORIES = 1_000;

function readEntry<T>(start: (resolve: (value: T) => void, reject: (error: DOMException) => void) => void, signal: AbortSignal, timeoutMs: number): Promise<T> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error?: unknown, value?: T) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      if (error) reject(error); else resolve(value!);
    };
    const abort = () => finish(new DOMException('Folder collection cancelled.', 'AbortError'));
    const timer = setTimeout(() => finish(new Error('Reading this folder timed out. Please try selecting it again.')), timeoutMs);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) { abort(); return; }
    try { start((value) => finish(undefined, value), (error) => finish(error)); } catch (error) { finish(error); }
  });
}

/** Browser readers return multiple batches; keep reading until an empty batch. */
export async function getDroppedItems(dataTransfer: DataTransfer, options: DropCollectionOptions = {}): Promise<DroppedItems> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  options.signal?.addEventListener('abort', abort, { once: true });
  if (options.signal?.aborted) controller.abort();
  const signal = controller.signal;
  const result: DroppedItems = { files: [], emptyDirectories: [] };
  const progress: DropCollectionProgress = { files: 0, directories: 0, bytes: 0 };
  const queue: FileSystemEntry[] = [];
  let queuedFiles = 0;
  let queuedDirectories = 0;
  const enqueue = (entries: FileSystemEntry[]) => {
    for (const entry of entries) {
      if (entry.isFile && ++queuedFiles > WORKSPACE_UPLOAD_MAX_FILES) throw new Error(`Select at most ${WORKSPACE_UPLOAD_MAX_FILES} files per upload.`);
      if (entry.isDirectory && ++queuedDirectories > MAX_DROP_DIRECTORIES) throw new Error(`Select at most ${MAX_DROP_DIRECTORIES} folders per upload.`);
      if (entry.fullPath.split('/').length > 101) throw new Error('The selected folder nesting exceeds 100 levels.');
      queue.push(entry);
    }
  };
  const addFile = (file: File, relativePath: string) => {
    if (file.size > WORKSPACE_UPLOAD_MAX_FILE_BYTES) throw new Error(`File "${relativePath}" exceeds the 5 GiB limit.`);
    progress.bytes += file.size;
    if (progress.bytes > WORKSPACE_UPLOAD_MAX_TOTAL_BYTES) throw new Error('The selected files exceed the 20 GiB upload limit.');
    if (++progress.files > WORKSPACE_UPLOAD_MAX_FILES) throw new Error(`Select at most ${WORKSPACE_UPLOAD_MAX_FILES} files per upload.`);
    result.files.push({ file, relativePath });
  };
  try {
    // Capture protected DataTransfer entries before the first await.
    enqueue(Array.from(dataTransfer.items ?? []).map((item) => item.webkitGetAsEntry?.()).filter((entry): entry is FileSystemEntry => Boolean(entry)));
    const fallbackFiles = queue.length ? [] : Array.from(dataTransfer.files ?? []);
    for (const file of fallbackFiles) { signal.throwIfAborted(); addFile(file, file.webkitRelativePath || file.name); }
    while (queue.length) {
      signal.throwIfAborted();
      await Promise.all(queue.splice(0, 8).map(async (entry) => {
        const relativePath = entry.fullPath.replace(/^\/+/, '');
        if (entry.isFile) {
          const file = await readEntry<File>((resolve, reject) => (entry as FileSystemFileEntry).file(resolve, reject), signal, options.timeoutMs ?? 30_000);
          addFile(file, relativePath);
        } else if (entry.isDirectory) {
          const reader = (entry as FileSystemDirectoryEntry).createReader();
          let entriesRead = 0;
          while (true) {
            const entries = await readEntry<FileSystemEntry[]>((resolve, reject) => reader.readEntries(resolve, reject), signal, options.timeoutMs ?? 30_000);
            if (!entries.length) break;
            entriesRead += entries.length;
            enqueue(entries);
          }
          progress.directories++;
          if (!entriesRead) result.emptyDirectories.push(relativePath);
        }
      }));
      options.onProgress?.({ ...progress });
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    signal.throwIfAborted();
    options.onProgress?.({ ...progress });
    return result;
  } catch (error) {
    controller.abort();
    throw error;
  } finally { options.signal?.removeEventListener('abort', abort); }
}

export async function getDroppedFiles(dataTransfer: DataTransfer): Promise<DroppedFile[]> {
  return (await getDroppedItems(dataTransfer)).files;
}
