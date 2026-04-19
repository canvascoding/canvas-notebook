import {
  File,
  Folder,
  FolderOpen,
  FileCode,
  FileText,
  Image as ImageIcon,
  FileVideo,
  FileAudio,
  FileSpreadsheet,
  FileDigit,
  Database,
  Presentation,
} from 'lucide-react';
import { getAppOutputFolderKind } from '../filesystem/app-output-folders';

export interface FileIconProps {
  name: string;
  path: string;
  type: 'file' | 'directory';
  isExpanded?: boolean;
  className?: string;
}

export function getFileIconComponent({
  name,
  path,
  type,
  isExpanded = false,
  className = 'h-4 w-4',
}: FileIconProps): React.ReactNode {
  const isDirectory = type === 'directory';

  if (isDirectory) {
    const outputKind = getAppOutputFolderKind(path);
    if (outputKind) {
      const badgeIcon =
        outputKind === 'veo-video-generation' ? (
          <FileVideo className="h-2.5 w-2.5 text-chart-4" />
        ) : outputKind === 'image-generations' ? (
          <ImageIcon className="h-2.5 w-2.5 text-chart-5" />
        ) : (
          <FileText className="h-2.5 w-2.5 text-chart-3" />
        );

      return (
        <span className="relative inline-flex shrink-0 items-center justify-center" style={{ width: '1em', height: '1em' }}>
          {isExpanded ? (
            <FolderOpen className={`${className} text-primary`} />
          ) : (
            <Folder className={`${className} text-primary`} />
          )}
          <span className="absolute -bottom-0.5 -right-0.5 rounded-full bg-background p-[1px]">
            {badgeIcon}
          </span>
        </span>
      );
    }
    return isExpanded ? (
      <FolderOpen className={`${className} text-primary`} />
    ) : (
      <Folder className={`${className} text-primary`} />
    );
  }

  const ext = name.split('.').pop()?.toLowerCase() || '';

  // Code & Scripts
  if (
    ['js', 'jsx', 'ts', 'tsx', 'html', 'css', 'scss', 'py', 'rb', 'go', 'rs', 'java', 'kt', 'php', 'sh', 'bash', 'zsh', 'yml', 'yaml', 'toml'].includes(ext)
  ) {
    return <FileCode className={`${className} text-chart-2`} />;
  }

  // Documents
  if (['md', 'mdx', 'markdown', 'txt', 'log'].includes(ext)) {
    return <FileText className={`${className} text-muted-foreground`} />;
  }
  if (ext === 'pdf') {
    return <FileText className={`${className} text-destructive`} />;
  }
  if (['doc', 'docx'].includes(ext)) {
    return <FileText className={`${className} text-primary`} />;
  }

  // Data & Config
  if (['json', 'env', 'gitignore'].includes(ext)) {
    return <FileDigit className={`${className} text-chart-3`} />;
  }
  if (['sql', 'db', 'sqlite'].includes(ext)) {
    return <Database className={`${className} text-chart-4`} />;
  }

  // Spreadsheet
  if (['xls', 'xlsx', 'csv'].includes(ext)) {
    return <FileSpreadsheet className={`${className} text-chart-2`} />;
  }

  // Presentation
  if (['ppt', 'pptx', 'pps', 'ppsx'].includes(ext)) {
    return <Presentation className={`${className} text-chart-3`} />;
  }

  // Media
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico'].includes(ext)) {
    return <ImageIcon className={`${className} text-chart-5`} />;
  }
  if (['mp4', 'webm', 'ogv', 'mov'].includes(ext)) {
    return <FileVideo className={`${className} text-chart-4`} />;
  }
  if (['wav', 'mp3', 'm4a', 'aac', 'ogg', 'opus', 'flac'].includes(ext)) {
    return <FileAudio className={`${className} text-chart-1`} />;
  }

  return <File className={`${className} text-muted-foreground`} />;
}

// Helper to determine if a file is an image
export function isImageFile(filename: string): boolean {
  const ext = filename.split('.').pop()?.toLowerCase() || '';
  return ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico'].includes(ext);
}

// Helper to get file extension
export function getFileExtension(filename: string): string {
  return filename.split('.').pop()?.toLowerCase() || '';
}
