import { readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { credentialResolver, readCredentialExport } from './credential-export.ts';
import { executeQueue, type QueueIO, type QueueStep } from './execute.ts';
import { importQueue, type QueueGraph } from './graph.ts';
import { createSheetReader } from './io.ts';

class CheckError extends Error {}

function inspectionGraph(graph: QueueGraph): QueueGraph {
  const required = new Map([
    ['Cron Trigger', 'n8n.cron'], ['Read Projects', 'n8n.googleSheets'], ['Read All Tasks', 'n8n.googleSheets'],
    ['Filter Ready Tasks', 'n8n.code'], ['IF Skip', 'n8n.if'], ['No Tasks Ready', 'n8n.noOp'], ['Check Stalled Tasks', 'n8n.code'],
  ]);
  const nodes = graph.nodes.filter(node => required.get(node.name) === node.type);
  if (nodes.length !== required.size || !nodes.some(node => node.id === graph.entry)) throw new CheckError('Unexpected queue_v9 inspection nodes');
  const ids = new Set(nodes.map(node => node.id));
  return { ...graph, nodes: nodes.map(node => ({
    ...node, on: Object.fromEntries(Object.entries(node.on).filter(([, target]) => ids.has(target))),
  })) };
}

function sheetsError(cause: unknown) {
  const message = cause instanceof Error ? cause.message : '';
  // Only emit known service names, status codes and standardized OAuth error names.
  const service = message.startsWith('Google OAuth') ? 'Google OAuth' : 'Google Sheets';
  const code = /\b(invalid_grant|invalid_client|invalid_request|unauthorized_client|unsupported_grant_type|invalid_scope|access_denied)\b/.exec(message)?.[1];
  const http = /\bHTTP (\d{3})\b/.exec(message)?.[1];
  return new CheckError([service, 'access failed', http && 'HTTP '+http, code].filter(Boolean).join(' · '));
}

async function main() {
  const [workflowFile, credentialFile] = process.argv.slice(2);
  if (!workflowFile || !credentialFile) throw new CheckError('Expected queue and credential export file paths');
  let graph: QueueGraph;
  try { graph = importQueue(JSON.parse(readFileSync(workflowFile, 'utf8'))); }
  catch { throw new CheckError('Cannot read or validate queue_v9 workflow'); }
  const inspect = inspectionGraph(graph);
  const settings = parseEnv(readFileSync(0, 'utf8'));
  const documentId = settings.GOOGLE_SHEET_ID;
  if (!documentId) throw new CheckError('Missing GOOGLE_SHEET_ID');
  const resolve = credentialResolver(readCredentialExport(credentialFile));
  const references: Record<string, boolean> = {};
  for (const node of graph.nodes) {
    for (const type of Object.keys(node.credentials ?? {})) {
      try {
        const data = resolve(node, type);
        const available = type !== 'telegramApi' || (typeof data.accessToken === 'string' && !!data.accessToken);
        references[type] = (references[type] ?? true) && available;
      } catch { references[type] = false; }
    }
  }
  console.log(JSON.stringify({credentialReferences: references}));
  if (!references.googleSheetsOAuth2Api) throw new CheckError('Cannot resolve Google Sheets credential reference');
  const readSheet = createSheetReader(documentId, resolve);
  const sheets = new Map<string,number>();
  let accessFailure: CheckError | undefined;
  const deny = async (): Promise<never> => { throw new Error('Unsupported operation in read-only inspection'); };
  const io: QueueIO = {
    async readSheet(node, doc, sheet) {
      if ((node.name==='Read Projects' && sheet!=='projects') || (node.name==='Read All Tasks' && sheet!=='tasks')) {
        throw new Error('Unexpected sheet for read-only inspection');
      }
      try {
        const rows = await readSheet(node, doc, sheet);
        sheets.set(sheet, rows.filter(row=>row.ID).length);
        return rows;
      } catch (cause) { accessFailure = sheetsError(cause); throw accessFailure; }
    },
    updateSheet: deny, http: deny, telegram: deny,
  };
  const env = { GOOGLE_SHEET_ID: documentId, MAX_PARALLEL_TASKS: settings.MAX_PARALLEL_TASKS ?? '',
    STALL_TIMEOUT_HOURS: settings.STALL_TIMEOUT_HOURS ?? '' };
  const result = await executeQueue(inspect, io, env);
  if (accessFailure) throw accessFailure;
  if (result.status !== 'done' || !sheets.has('projects') || !sheets.has('tasks')) throw new CheckError('Queue inspection did not complete');
  const count = (name:string, field:'input'|'output') => result.trace
    .filter((step: QueueStep) => step.node === name).reduce((total,step) => total + step[field],0);
  console.log(JSON.stringify({projects: sheets.get('projects'), tasks: sheets.get('tasks'),
    ready: count('IF Skip','input') - count('No Tasks Ready','input'), stalled: count('Check Stalled Tasks','output')}));
  if (Object.values(references).includes(false)) throw new CheckError('Some credential references could not be resolved');
}

main().catch((error: unknown) => {
  console.error(error instanceof CheckError ? error.message : 'Cannot read configuration or credential export');
  process.exitCode = 1;
});
