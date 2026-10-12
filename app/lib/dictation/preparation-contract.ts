export type LocalPreparation = {
  id: string;
  model: string;
  engine?: 'whisper-cpp' | 'faster-whisper';
  state: 'running' | 'succeeded' | 'failed';
  phase: 'runtime' | 'downloading' | 'verifying' | 'loading' | 'testing' | 'ready' | 'failed';
  downloadedBytes?: number;
  totalBytes?: number;
  startedAt: number;
  updatedAt: number;
  message?: string;
  result?: { text: string; durationMs: number; checkedAt: number; language: string };
};
