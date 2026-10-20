import { withManagedAgentCreationLease } from '../../app/lib/agents/creation-lifecycle';
import { closeDatabaseConnections } from '../../app/lib/db';

async function main() {
  const agentId = process.argv[2];
  if (!/^creation-lease-[a-f0-9]{8}$/u.test(agentId ?? '')) throw new Error('An owned test identity is required.');
  process.send?.('attempting');
  await withManagedAgentCreationLease({ name: agentId, agentId }, async () => { process.send?.('acquired'); });
}
void main().catch(error => { process.send?.({ error: String(error) }); process.exitCode = 1; }).finally(async () => {
  await closeDatabaseConnections(); process.disconnect?.();
});
