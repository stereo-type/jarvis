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
      CREATE TABLE IF NOT EXISTS jarvis_runs (
        id uuid PRIMARY KEY, actor text NOT NULL, workflow text NOT NULL, revision integer NOT NULL,
        step text NOT NULL, status text NOT NULL CHECK (status IN ('waiting','ready','done')),
        outputs jsonb NOT NULL DEFAULT '{}', command uuid NOT NULL, attempts integer NOT NULL DEFAULT 0,
        lease uuid, due timestamptz NOT NULL DEFAULT now(), expires timestamptz,
        FOREIGN KEY (workflow, revision) REFERENCES jarvis_definitions
      );
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
    `);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
