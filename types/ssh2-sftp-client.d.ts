declare module 'ssh2-sftp-client' {
  interface SftpStat {
    size: number;
    mtime: number;
    isDirectory: boolean;
    isFile: boolean;
    mode?: number;
  }

  interface SftpListItem {
    name: string;
    type: 'd' | '-' | 'l';
    size: number;
    modifyTime: number;
    rights?: { octal?: string };
  }

  class SFTPClient {
    connect(options: { sock: unknown }): Promise<void>;
    end(): Promise<void>;
    get(path: string): Promise<Buffer>;
    list(path: string): Promise<SftpListItem[]>;
    put(data: Buffer | string, path: string): Promise<void>;
    mkdir(path: string, recursive?: boolean): Promise<void>;
    rmdir(path: string, recursive?: boolean): Promise<void>;
    delete(path: string): Promise<void>;
    rename(oldPath: string, newPath: string): Promise<void>;
    stat(path: string): Promise<SftpStat>;
  }

  export default SFTPClient;
}
