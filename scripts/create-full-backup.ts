import {
  createFullBackupJob,
  getFullBackupJob,
  promoteFullBackupJobToLatest,
  pruneFullBackupJobArtifacts,
} from '../app/lib/backups/full-backup-service';
import type { FullBackupJob } from '../app/lib/backups/types';

interface CreateFullBackupOptions {
  json: boolean;
  noWait: boolean;
  latest: boolean;
  targetDir?: string;
  keepJobArtifacts: boolean;
}

async function waitForBackup(backupId: string) {
  for (let attempt = 0; attempt < 3600; attempt++) {
    const job = await getFullBackupJob(backupId);
    if (job?.status === 'completed') return job;
    if (job?.status === 'failed') throw new Error(job.error || 'Full backup failed.');
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`Timed out waiting for full backup ${backupId}.`);
}

function readOptionValue(args: string[], index: number, option: string): { value: string; nextIndex: number } {
  const inlinePrefix = `${option}=`;
  const current = args[index] || '';
  if (current.startsWith(inlinePrefix)) {
    const value = current.slice(inlinePrefix.length);
    if (!value) throw new Error(`Missing value for ${option}.`);
    return { value, nextIndex: index };
  }
  const value = args[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`Missing value for ${option}.`);
  return { value, nextIndex: index + 1 };
}

function parseOptions(argv: string[]): CreateFullBackupOptions {
  const options: CreateFullBackupOptions = {
    json: false,
    noWait: false,
    latest: false,
    keepJobArtifacts: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--json') options.json = true;
    else if (arg === '--no-wait') options.noWait = true;
    else if (arg === '--latest') options.latest = true;
    else if (arg === '--keep-job-artifacts') options.keepJobArtifacts = true;
    else if (arg === '--target-dir' || arg.startsWith('--target-dir=')) {
      const parsed = readOptionValue(argv, i, '--target-dir');
      options.targetDir = parsed.value;
      i = parsed.nextIndex;
    } else {
      throw new Error(`Unknown backup option: ${arg}`);
    }
  }
  if (options.latest && options.noWait) {
    throw new Error('--latest cannot be combined with --no-wait because promotion requires a completed backup.');
  }
  return options;
}

function serializeJob(job: FullBackupJob): Omit<FullBackupJob, 'filePath'> {
  const safeJob = { ...job } as FullBackupJob & { filePath?: string };
  delete safeJob.filePath;
  return safeJob;
}

async function main() {
  const options = parseOptions(process.argv.slice(2));
  const job = await createFullBackupJob({
    source: {
      createdByUserId: 'cli',
      createdByEmail: null,
      createdByRole: 'system',
    },
  });

  if (options.noWait) {
    if (options.json) {
      console.log(JSON.stringify({ success: true, job: serializeJob(job) }, null, 2));
    } else {
      console.log(`Full backup queued: ${job.id}`);
    }
    return;
  }

  const completed = await waitForBackup(job.id);
  let latest: Awaited<ReturnType<typeof promoteFullBackupJobToLatest>> | null = null;
  let prunedBackupIds: string[] = [];
  if (options.latest) {
    latest = await promoteFullBackupJobToLatest(completed, { targetDir: options.targetDir });
    if (!options.keepJobArtifacts) {
      prunedBackupIds = await pruneFullBackupJobArtifacts();
    }
  }

  if (options.json) {
    console.log(JSON.stringify({
      success: true,
      job: serializeJob(completed),
      latest,
      prunedBackupIds,
    }, null, 2));
  } else {
    console.log(`Full backup completed: ${latest?.filePath || completed.filePath}`);
  }
}

main().catch((error) => {
  if (process.argv.includes('--json')) {
    console.error(JSON.stringify({ success: false, error: error instanceof Error ? error.message : String(error) }));
  } else {
    console.error(error);
  }
  process.exit(1);
});
