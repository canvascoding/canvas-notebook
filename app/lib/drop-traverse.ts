export interface DroppedFile {
  file: File;
  relativePath: string;
}

function traverseFileEntry(entry: FileSystemFileEntry): Promise<DroppedFile> {
  return new Promise((resolve) => {
    entry.file((file) => {
      const relativePath = entry.fullPath.replace(/^\/+/, '');
      resolve({ file, relativePath });
    });
  });
}

function traverseDirectoryEntry(entry: FileSystemDirectoryEntry): Promise<DroppedFile[]> {
  return new Promise((resolve) => {
    const reader = entry.createReader();
    const allEntries: FileSystemEntry[] = [];

    const readBatch = () => {
      reader.readEntries(async (entries) => {
        if (entries.length === 0) {
          const results = await Promise.all(
            allEntries.map((e) => traverseEntry(e))
          );
          resolve(results.flat());
          return;
        }
        allEntries.push(...entries);
        readBatch();
      });
    };

    readBatch();
  });
}

function traverseEntry(entry: FileSystemEntry): Promise<DroppedFile[]> {
  if (entry.isFile) {
    return traverseFileEntry(entry as FileSystemFileEntry).then((f) => [f]);
  }
  if (entry.isDirectory) {
    return traverseDirectoryEntry(entry as FileSystemDirectoryEntry);
  }
  return Promise.resolve([]);
}

export async function getDroppedFiles(
  dataTransfer: DataTransfer
): Promise<DroppedFile[]> {
  const items = dataTransfer.items;
  if (items) {
    const entries: FileSystemEntry[] = [];
    for (let i = 0; i < items.length; i++) {
      const entry = items[i].webkitGetAsEntry?.();
      if (entry) entries.push(entry);
    }
    if (entries.length > 0) {
      const results = await Promise.all(entries.map(traverseEntry));
      return results.flat();
    }
  }

  return Array.from(dataTransfer.files ?? []).map((file) => ({
    file,
    relativePath: file.name,
  }));
}