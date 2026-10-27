import { AgenticViewClient } from '../clients/client.ts';

const key = process.env.AV_INGEST_KEY;
if (!key) throw new Error('Set AV_INGEST_KEY to the installation ingestion key.');
const agent = await AgenticViewClient.connect(process.env.AV_URL || 'http://127.0.0.1:4317', key, { agentId: 'synthetic-tool', name: 'Synthetic tool', role: 'Example integration', context: 'A synthetic metric stream. No external systems are accessed.' });
agent.startHeartbeat(error => console.error((error as Error).message));
let value = 0;
const timer = setInterval(() => { void agent.display({ id: 'work', title: 'Synthetic completed items', kind: 'metric', data: { value: ++value, unit: 'items', tone: 'info' } }).catch(error => console.error(error.message)); }, 1_000);
async function finish() { clearInterval(timer); await agent.archive(); }
process.once('SIGINT', () => { void finish(); });
process.once('SIGTERM', () => { void finish(); });
console.log('Synthetic agent connected. Press Ctrl+C to archive its card.');
