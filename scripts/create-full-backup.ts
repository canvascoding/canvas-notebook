import { createFullBackupJob, getFullBackupJob } from '../app/lib/backups/full-backup-service';

async function waitForBackup(backupId: string) {
  for (let attempt = 0; attempt < 3600; attempt++) {
    const job = await getFullBackupJob(backupId);
    if (job?.status === 'completed') return job;
    if (job?.status === 'failed') throw new Error(job.error || 'Full backup failed.');
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`Timed out waiting for full backup ${backupId}.`);
}

async function main() {
  const json = process.argv.includes('--json');
  const noWait = process.argv.includes('--no-wait');
  const job = await createFullBackupJob({
    source: {
      createdByUserId: 'cli',
      createdByEmail: null,
      createdByRole: 'system',
    },
  });

  if (noWait) {
    if (json) {
      console.log(JSON.stringify({ success: true, job }, null, 2));
    } else {
      console.log(`Full backup queued: ${job.id}`);
    }
    return;
  }

  const completed = await waitForBackup(job.id);
  if (json) {
    console.log(JSON.stringify({ success: true, job: completed }, null, 2));
  } else {
    console.log(`Full backup completed: ${completed.filePath}`);
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
