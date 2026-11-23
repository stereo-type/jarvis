import type { Pool } from 'pg';

export async function migrate(pool: Pool) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(68131001)');
    await client.query(`
      CREATE TABLE IF NOT EXISTS jarvis_definitions (
        workflow text NOT NULL, revision integer NOT NULL, snapshot jsonb NOT NULL,
        PRIMARY KEY (workflow, revision)
      );
      CREATE TABLE IF NOT EXISTS jarvis_workflow_drafts (
        workflow text PRIMARY KEY, base_revision integer NOT NULL, version uuid NOT NULL, graph jsonb NOT NULL,
        FOREIGN KEY (workflow, base_revision) REFERENCES jarvis_definitions(workflow, revision)
      );
      CREATE TABLE IF NOT EXISTS jarvis_runs (
        id uuid PRIMARY KEY, actor text NOT NULL, workflow text NOT NULL, revision integer NOT NULL,
        step text NOT NULL, status text NOT NULL CHECK (status IN ('waiting','ready','done')),
        outputs jsonb NOT NULL DEFAULT '{}', command uuid NOT NULL, attempts integer NOT NULL DEFAULT 0,
        lease uuid, due timestamptz NOT NULL DEFAULT now(), expires timestamptz,
        FOREIGN KEY (workflow, revision) REFERENCES jarvis_definitions
      );
      ALTER TABLE jarvis_workflow_drafts ALTER COLUMN base_revision DROP NOT NULL;
      CREATE TABLE IF NOT EXISTS jarvis_queue_runs (
        id uuid PRIMARY KEY, actor text NOT NULL, workflow text NOT NULL, revision integer NOT NULL,
        request_id uuid NOT NULL, mode text NOT NULL CHECK(mode IN ('test','live')),
        status text NOT NULL CHECK(status IN ('queued','running','done','failed')),
        created timestamptz NOT NULL DEFAULT now(), heartbeat timestamptz, result jsonb,
        FOREIGN KEY(workflow,revision) REFERENCES jarvis_definitions,
        UNIQUE(actor,request_id)
      );
      CREATE INDEX IF NOT EXISTS jarvis_queue_pending ON jarvis_queue_runs(created) WHERE status='queued';
      CREATE UNIQUE INDEX IF NOT EXISTS jarvis_queue_live ON jarvis_queue_runs(mode) WHERE mode='live' AND status IN ('queued','running');
      CREATE INDEX IF NOT EXISTS jarvis_work ON jarvis_runs(due) WHERE status='ready';
      ALTER TABLE jarvis_runs ADD COLUMN IF NOT EXISTS uncertain boolean NOT NULL DEFAULT false;
      ALTER TABLE jarvis_runs ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now();
      CREATE INDEX IF NOT EXISTS jarvis_actor_runs ON jarvis_runs(actor, workflow, created_at DESC);
      CREATE INDEX IF NOT EXISTS jarvis_expiry ON jarvis_runs(expires) WHERE status='waiting';
      CREATE TABLE IF NOT EXISTS jarvis_attempts (
        request uuid PRIMARY KEY, run uuid NOT NULL REFERENCES jarvis_runs, step text NOT NULL,
        operation text NOT NULL, attempt integer NOT NULL, started timestamptz NOT NULL DEFAULT now(),
        finished timestamptz, outcome text
      );
      ALTER TABLE jarvis_attempts ADD COLUMN IF NOT EXISTS command uuid;
      CREATE TABLE IF NOT EXISTS jarvis_cinema_searches (
        id uuid PRIMARY KEY, actor text NOT NULL, expires timestamptz NOT NULL, releases jsonb NOT NULL
      );
      CREATE INDEX IF NOT EXISTS jarvis_cinema_search_expiry ON jarvis_cinema_searches(expires);
      CREATE TABLE IF NOT EXISTS jarvis_cinema_deliveries (
        command uuid PRIMARY KEY, run uuid NOT NULL REFERENCES jarvis_runs ON DELETE CASCADE,
        step text NOT NULL, peer text NOT NULL, digest text NOT NULL, document bytea,
        tries integer NOT NULL DEFAULT 0, next_send timestamptz NOT NULL DEFAULT now(),
        deadline timestamptz NOT NULL DEFAULT now()+interval '5 minutes',
        receipt text CHECK(receipt IN ('stored','uncertain','rejected')),
        local_failure boolean NOT NULL DEFAULT false
      );
    `);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
