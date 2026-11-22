import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import { compileCatalog } from './config/catalog.ts';
import { id } from './config/schema.ts';
import { compileWorkflow } from './config/workflow.ts';
import { HttpError } from './telegram/auth.ts';
import { importQueue, queueGraph, validateQueue, type QueueGraph } from './n8n/graph.ts';

const point = z.number().finite().min(-100000).max(100000);
const draftGraph = z.object({
  schemaVersion: z.literal('jarvis.workflow/v1'), id: z.string(), revision: z.number().int().positive(),
  title: z.string(), entry: z.string(), nodes: z.array(z.object({
    id, type: z.enum(['ui.form','service.call','flow.hasItems','ui.choice','ui.result']),
    position: z.tuple([point, point]), on: z.record(id).optional(),
  }).passthrough()).max(300),
}).strict().refine(g => new Set(g.nodes.map(n => n.id)).size === g.nodes.length, 'Повторяется ID узла');
type Graph = z.infer<typeof draftGraph> | QueueGraph;
const cursor = z.object({ revision: z.number().int().nonnegative(), version: z.string().uuid().nullable() });
type Row = {
  revision: number; snapshot: {graph: Graph; config?: unknown; api?: unknown} | null;
  version: string | null; draft: Graph | null; base: number | null;
};
async function lookup(db: Pool | PoolClient, workflow: string) {
  const {rows} = await db.query<Row>(`SELECT coalesce(d.revision,0) AS revision, d.snapshot, w.version, w.graph AS draft, w.base_revision AS base
    FROM (VALUES ($1::text)) AS k(workflow)
    LEFT JOIN LATERAL (SELECT revision,snapshot FROM jarvis_definitions WHERE workflow=k.workflow ORDER BY revision DESC LIMIT 1) d ON true
    LEFT JOIN jarvis_workflow_drafts w USING(workflow)
    WHERE d.revision IS NOT NULL OR w.version IS NOT NULL`, [workflow]);
  return rows[0];
}
async function current(db: Pool | PoolClient, workflow: string) {
  const row=await lookup(db,workflow);
  if(!row)throw new HttpError(404,'Workflow не найден.');
  return row;
}
function document(row: Row) {
  const graph=row.draft ?? row.snapshot!.graph;
  const catalog = graph.schemaVersion==='jarvis.n8n/v1' ? null : compileCatalog(row.snapshot!.config, row.snapshot!.api, 'каталог workflow');
  return {
    revision: row.revision, version: row.version, base: row.base ?? row.revision,
    graph,
    operations: catalog ? [...catalog.operations].map(([operationId, op]) => ({
      operationId, service: catalog.service, apiMajor: catalog.major,
      inputs: [...op.input].map(([key, shape]) => ({key, type: shape.type, required: op.required.has(key)})),
    })) : [],
  };
}

export class WorkflowEditor {
  private pool: Pool;
  constructor(pool: Pool) { this.pool = pool; }

  async list() {
    return (await this.pool.query(`WITH latest AS (SELECT DISTINCT ON (workflow) workflow,revision,snapshot
      FROM jarvis_definitions ORDER BY workflow, revision DESC)
      SELECT workflow AS id, coalesce(revision,0) AS revision, coalesce(w.graph,d.snapshot->'graph')->>'title' AS title
      FROM latest d FULL JOIN jarvis_workflow_drafts w USING(workflow) ORDER BY workflow`)).rows;
  }
  async import(raw:unknown) {
    const graph=importQueue(raw);
    const row=await lookup(this.pool,graph.id);
    if(row && (row.draft??row.snapshot?.graph)?.schemaVersion!==graph.schemaVersion)throw new HttpError(409,'ID занят другим workflow.');
    return {...document(row??{revision:0,snapshot:null,version:null,draft:graph,base:null}),graph:{...graph,revision:row?.revision??0}};
  }

  async read(workflow: string) { return document(await current(this.pool, workflow)); }

  async write(workflow: string, action: 'draft' | 'publish' | 'discard', input: unknown) {
    const expected = cursor.parse(input);
    const graph = action === 'draft' ? cursor.extend({graph: z.union([draftGraph,queueGraph])}).strict().parse(input).graph : undefined;
    if (graph && (graph.id !== workflow || graph.revision !== expected.revision)) throw new HttpError(400,'ID или ревизия графа не совпадает.');
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      // CLI тоже публикует определения. Блокировка сериализует короткие записи, сохраняя доступ runner на чтение.
      await client.query('LOCK TABLE jarvis_definitions IN SHARE ROW EXCLUSIVE MODE');
      const existing=await lookup(client,workflow);
      if(!existing && (!graph || graph.schemaVersion!=='jarvis.n8n/v1'))throw new HttpError(404,'Workflow не найден.');
      const row=existing??{revision:0,snapshot:null,version:null,draft:null,base:null};
      const format=(row.draft??row.snapshot?.graph)?.schemaVersion;
      if(graph && format && format!==graph.schemaVersion)throw new HttpError(400,'Формат workflow изменён.');
      if (expected.revision !== row.revision || expected.version !== row.version) {
        throw new HttpError(409,'Граф изменён в другом окне. Откройте актуальную версию.');
      }
      if (action !== 'discard' && row.base !== null && row.base !== row.revision) {
        throw new HttpError(409,'Опубликована новая ревизия. Экспортируйте нужные правки и сбросьте старый черновик.');
      }
      if (graph) {
        await client.query(`INSERT INTO jarvis_workflow_drafts(workflow,base_revision,version,graph) VALUES($1,$2,$3,$4)
          ON CONFLICT(workflow) DO UPDATE SET base_revision=excluded.base_revision, version=excluded.version, graph=excluded.graph`,
          [workflow,row.revision || null,randomUUID(),graph]);
      } else {
        if (!row.draft) throw new HttpError(409,'Сохранённого черновика нет.');
        if (action === 'publish') {
          const revision = row.revision + 1;
          const snapshot = {...row.snapshot, graph:{...row.draft, revision}};
          if(snapshot.graph.schemaVersion==='jarvis.n8n/v1') validateQueue(snapshot.graph);
          else {
            const catalog = compileCatalog(snapshot.config, snapshot.api, 'каталог workflow');
            try { compileWorkflow(snapshot.graph, catalog, workflow); }
            catch (err) { throw new HttpError(422, err instanceof Error ? err.message : 'Некорректный граф'); }
          }
          await client.query('INSERT INTO jarvis_definitions(workflow,revision,snapshot) VALUES($1,$2,$3)', [workflow,revision,snapshot]);
        }
        await client.query('DELETE FROM jarvis_workflow_drafts WHERE workflow=$1',[workflow]);
      }
      const remaining=await lookup(client,workflow);
      const saved=remaining?document(remaining):{deleted:true};
      await client.query('COMMIT');
      return saved;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally { client.release(); }
  }
}
