import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { compileCatalog, readCatalogFiles } from '../config/catalog.ts';
import { readJson } from '../config/schema.ts';
import { compileWorkflow, type WorkflowNode } from '../config/workflow.ts';
import { callService } from './service-call.ts';

type Snapshot = { graph: unknown; config: unknown; api: unknown };
type Run = {
  id: string; actor: string; workflow: string; revision: number; step: string;
  status: 'ready' | 'waiting' | 'done'; command: string; lease: string | null; attempts: number; uncertain: boolean;
  outputs: Record<string, unknown>; expires: Date | null; snapshot: Snapshot;
};
function compile(snapshot: Snapshot) {
  const catalog = compileCatalog(snapshot.config, snapshot.api, 'опубликованный контракт');
  return { catalog, graph: compileWorkflow(snapshot.graph, catalog, 'опубликованный граф') };
}
type Definition = ReturnType<typeof compile>;

export class RunNotFound extends Error {}
export class InvalidAction extends Error {}

function resolveValue(value: unknown, outputs: Record<string, unknown>): unknown {
  if (typeof value !== 'object' || !value || !('$ref' in value) || typeof value.$ref !== 'string') return value;
  let current: unknown = outputs;
  for (const segment of value.$ref.split('.')) {
    if (!current || typeof current !== 'object' || !Object.hasOwn(current, segment)) throw new Error('Недоступное поле ' + value.$ref);
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function items(node: Extract<WorkflowNode, {type:'ui.choice'}>, run: Run) {
  return resolveValue(node.items, run.outputs) as Record<string, unknown>[];
}

const joinedRun = 'SELECT r.*, d.snapshot FROM jarvis_runs r JOIN jarvis_definitions d USING(workflow,revision)';

export class Runner {
  private pool: Pool;
  private env: NodeJS.ProcessEnv;

  constructor(pool: Pool, env = process.env) {
    this.pool = pool;
    this.env = env;
  }

  async publish(connection: string, workflow: string) {
    const snapshot = { ...await readCatalogFiles(connection), graph: await readJson(workflow) };
    const { graph } = compile(snapshot);
    const saved = await this.pool.query(`INSERT INTO jarvis_definitions(workflow,revision,snapshot) VALUES($1,$2,$3)
      ON CONFLICT(workflow,revision) DO UPDATE SET snapshot=excluded.snapshot
      WHERE jarvis_definitions.snapshot=excluded.snapshot RETURNING revision`, [graph.id, graph.revision, snapshot]);
    if (!saved.rowCount) throw new Error('Ревизия уже опубликована с другим содержимым');
    return { workflow: graph.id, revision: graph.revision };
  }

  async start(workflow: string, actor: string) {
    if (!/^[1-9][0-9]*$/.test(actor)) throw new Error('Требуется числовой Telegram ID');
    const id = randomUUID();
    const result = await this.pool.query(`INSERT INTO jarvis_runs(id,actor,workflow,revision,step,status,command)
      SELECT $1,$2,workflow,revision,snapshot->'graph'->>'entry','waiting',$3 FROM jarvis_definitions
      WHERE workflow=$4 ORDER BY revision DESC LIMIT 1`, [id, actor, randomUUID(), workflow]);
    if (!result.rowCount) throw new Error('Workflow не опубликован');
    return id;
  }

  private async owned(id: string, actor: string) {
    const result = await this.pool.query<Run>(joinedRun + ' WHERE r.id=$1 AND r.actor=$2', [id, actor]);
    if (!result.rows[0]) throw new RunNotFound('Запуск не найден');
    return result.rows[0];
  }

  async view(id: string, actor: string) {
    const run = await this.owned(id, actor);
    const node = compile(run.snapshot).graph.nodes.get(run.step)!;
    const base = { id, step: run.step, status: run.status, workflow: run.workflow, revision: run.revision };
    switch (node.type) {
      case 'ui.form': return { ...base, title: node.title, fields: node.fields };
      case 'ui.choice': return { ...base, title: node.title, expiresAt: run.expires, choices: items(node, run).map(item => ({
        value: item[node.valueField], label: item[node.labelField], details: Object.fromEntries(node.detailFields.map(k => [k, item[k]])),
      })) };
      case 'ui.result': return { ...base, title: node.title, receipt: resolveValue(node.receipt, run.outputs) };
      default: return base;
    }
  }

  async history(id: string, actor: string) {
    await this.owned(id, actor);
    const result = await this.pool.query(`SELECT request, command, step, operation, attempt, started, finished, outcome
      FROM jarvis_attempts WHERE run=$1 ORDER BY started,request`, [id]);
    return result.rows;
  }

  async recent(actor: string, workflow: string) {
    const result = await this.pool.query(`SELECT id, step, status, created_at AS "createdAt",
      outputs->'query'->>'query' AS query FROM jarvis_runs
      WHERE actor=$1 AND workflow=$2 ORDER BY created_at DESC, id DESC LIMIT 20`, [actor, workflow]);
    return result.rows;
  }

  private async advance(run: Run, def: Definition, dest: string, output?: unknown, requireValidChoice = false) {
    const outputs = output === undefined ? run.outputs : { ...run.outputs, [run.step]: output };
    const next = def.graph.nodes.get(dest)!;
    const status = next.type === 'ui.result' ? 'done' : ['ui.form','ui.choice'].includes(next.type) ? 'waiting' : 'ready';
    const expires = next.type === 'ui.choice' ? resolveValue(next.expiresAt, outputs) : null;
    // Условие по step и lease отсекает повторный клик и запоздалый ответ предыдущего worker.
    const changed = await this.pool.query(`UPDATE jarvis_runs SET step=$5,status=$6,outputs=$7,expires=$8,
      command=$9,attempts=0,lease=NULL,uncertain=false,due=now()
      WHERE id=$1 AND actor=$2 AND step=$3 AND lease IS NOT DISTINCT FROM $4::uuid
      AND (NOT $10::boolean OR expires>clock_timestamp())`,
      [run.id, run.actor, run.step, run.lease, dest, status, outputs, expires, randomUUID(), requireValidChoice]);
    return changed.rowCount === 1;
  }

  async act(id: string, actor: string, step: string, event: string, data: Record<string, unknown> = {}) {
    const run = await this.owned(id, actor);
    if (run.step !== step || run.status !== 'waiting') return false;
    const def = compile(run.snapshot);
    const node = def.graph.nodes.get(step)!;
    if (node.type === 'ui.form' && event === 'submit') {
      const fields: Record<string, string> = Object.create(null);
      for (const f of node.fields) {
        const raw = data[f.key];
        if (typeof raw !== 'string') throw new InvalidAction('Отсутствует поле ' + f.key);
        const value = f.trim ? raw.trim() : raw;
        const length = Array.from(value).length;
        if (length < (f.minLength ?? 0) || length > (f.maxLength ?? Infinity)) throw new InvalidAction('Недопустимая длина ' + f.key);
        fields[f.key] = value;
      }
      return this.advance(run, def, node.on.submit!, fields);
    }
    if (node.type === 'ui.choice') {
      if (run.expires && run.expires.getTime() <= Date.now()) return this.advance(run, def, node.on.expired!);
      if (event === 'cancel') return this.advance(run, def, node.on.cancel!);
      if (event === 'select' && items(node, run).some(item => item[node.valueField] === data.value)) {
        return this.advance(run, def, node.on.select!, { value: data.value }, true);
      }
    }
    throw new InvalidAction('Недопустимое действие или значение выбора');
  }

  async tick(): Promise<boolean> {
    const lease = randomUUID();
    const result = await this.pool.query<Run>(`WITH candidate AS (
      SELECT id FROM jarvis_runs WHERE due<=now() AND (status='ready' OR (status='waiting' AND expires<=now()))
      ORDER BY due,id LIMIT 1 FOR UPDATE SKIP LOCKED
    ), claimed AS (
      UPDATE jarvis_runs r SET lease=$1, due=now()+interval '75 seconds', attempts=attempts+1,
        uncertain=uncertain OR lease IS NOT NULL
      FROM candidate WHERE r.id=candidate.id RETURNING r.*
    ) SELECT claimed.*, d.snapshot FROM claimed JOIN jarvis_definitions d USING(workflow,revision)`, [lease]);
    const run = result.rows[0];
    if (!run) return false;
    const def = compile(run.snapshot);
    const node = def.graph.nodes.get(run.step)!;
    if (node.type === 'ui.choice') {
      await this.advance(run, def, node.on.expired!);
    } else if (node.type === 'flow.hasItems') {
      const values = resolveValue(node.items, run.outputs) as unknown[];
      await this.advance(run, def, values.length ? node.on.yes! : node.on.no!);
    } else if (node.type === 'service.call') {
      await this.executeCall(run, def, node);
    } else throw new Error('Шаг не предназначен для worker');
    return true;
  }

  private async executeCall(run: Run, def: Definition, node: Extract<WorkflowNode, { type: 'service.call' }>) {
    const op = def.catalog.operations.get(node.operationId)!;
    const errorPort = (code: string) => node.on['error.' + code] ?? node.on.error!;
    if (run.attempts > 3 || (!op.idempotent && run.attempts > 1)) {
      await this.advance(run, def, errorPort(op.method === 'post' ? 'HANDOFF_UNCERTAIN' : 'ATTEMPTS_EXHAUSTED'));
      return;
    }
    const args = Object.fromEntries(Object.entries(node.args).map(([k, v]) => [k, resolveValue(v, run.outputs)]));
    const request = randomUUID();
    await this.pool.query('INSERT INTO jarvis_attempts(request,run,step,operation,attempt,command) VALUES($1,$2,$3,$4,$5,$6)',
      [request, run.id, run.step, node.operationId, run.attempts, run.command]);
    const config = def.catalog.config;
    const response = await callService(op, args, run.actor, run.command, request,
      this.env[config.baseUrlEnv], this.env[config.credential.tokenEnv]);
    await this.pool.query('UPDATE jarvis_attempts SET finished=now(),outcome=$2 WHERE request=$1',
      [request, response.ok ? 'success' : response.code]);
    if (response.ok) {
      await this.advance(run, def, node.on.success!, response.data);
    } else if (response.retryable && op.idempotent && run.attempts < 3) {
      await this.pool.query(`UPDATE jarvis_runs SET lease=NULL,due=now()+($3 * interval '1 second'),
        uncertain=uncertain OR $4 WHERE id=$1 AND lease=$2`,
        [run.id, run.lease, Math.max(response.delay, run.attempts), response.ambiguous]);
    } else {
      const uncertain = op.method === 'post' && (run.uncertain || response.ambiguous);
      await this.advance(run, def, errorPort(uncertain ? 'HANDOFF_UNCERTAIN' : response.code));
    }
  }
}
