declare module 'zip-stream' {
  import type { Stats } from 'fs';
  import type { Transform } from 'stream';

  interface ZipStreamOptions {
    level?: number;
    zlib?: {
      level?: number;
    };
    forceZip64?: boolean;
    store?: boolean;
  }

  interface ZipEntryData {
    name: string;
    type?: 'file' | 'directory' | 'symlink';
    stats?: Stats;
  }

  class ZipStream extends Transform {
    constructor(options?: ZipStreamOptions);
    entry(
      source: NodeJS.ReadableStream | Buffer | string | null,
      data: ZipEntryData,
      callback: (error?: Error | null) => void
    ): this;
    finish(): void;
  }

  export = ZipStream;
}
