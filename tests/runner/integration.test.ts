import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { promisify } from 'node:util';
import { Pool } from 'pg';
import { Runner } from '../../src/runner/engine.ts';
import { migrate } from '../../src/runner/storage.ts';

const exec = promisify(execFile);
const connection = 'examples/services/filmobot.connection.json';
const graph = 'examples/workflows/cinema-search.json';
const actor = '42';
const cli = async (...args: string[]) => {
  const result = await exec(process.execPath, ['src/run.ts', ...args]);
  return JSON.parse(result.stdout);
};
const fixture = async () => {
  const res = await fetch('http://filmobot:8080/fixture');
  return await res.json() as { files: number; history: number; requests: string[] };
};

test('PostgreSQL и Filmobot: перезапуск, конкуренция и восстановление незавершённой команды', { timeout: 90000 }, async t => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL! });
  t.after(() => pool.end());
  const runner = new Runner(pool);
  await migrate(pool);
  await runner.publish(connection, graph);
  const name = 'cinema.search-and-download';
  async function waitForChoice() {
    const id = await runner.start(name, actor);
    assert.equal(await runner.act(id, actor, 'query', 'submit', { query: 'Фильм' }), true);
    await cli('tick');
    await cli('tick');
    return id;
  }
  const run = await waitForChoice();
  const view = await cli('show', run, actor);
  assert.equal(view.step, 'choose');
  assert.equal(view.choices[0].value, 'rutor:1');
  await assert.rejects(runner.view(run,'99'), /Запуск не найден/);
  await assert.rejects(runner.act(run,actor,'choose','select',{value:'rutor:999'}), /Недопустимое/);

  const dir = await mkdtemp(join(tmpdir(),'jarvis-run-'));
  t.after(() => rm(dir,{recursive:true,force:true}));
  const changed = JSON.parse(await readFile(graph,'utf8'));
  changed.title += ' v2';
  const next = join(dir,'graph.json');
  await writeFile(next, JSON.stringify(changed));
  await assert.rejects(runner.publish(connection,next),/Ревизия/);
  changed.revision = 2;
  await writeFile(next, JSON.stringify(changed));
  await runner.publish(connection,next);
  assert.deepEqual(await cli('show',run,actor),view);
  const click = () => cli('act',run,actor,'choose','select',JSON.stringify({value:'rutor:1'}));
  assert.deepEqual((await Promise.all([click(),click()])).sort(), [false,true]);
  await Promise.all([cli('tick'),cli('tick')]);
  const done = await cli('show',run,actor);
  assert.equal(done.step,'submitted');
  assert.equal(done.revision,1);
  assert.match(done.receipt,/^[a-f0-9-]{36}$/);
  const first = await fixture();
  assert.equal(first.files,1);
  assert.equal(first.history,1);
  assert.equal(first.requests.length,1);

  const interrupted = await waitForChoice();
  await runner.act(interrupted,actor,'choose','select',{value:'rutor:1'});
  await fetch('http://filmobot:8080/fixture', { method: 'POST' });
  const child = spawn(process.execPath,['src/run.ts','tick'],{stdio:'ignore'});
  const stopped = once(child,'exit');
  try {
    for (let i=0; i<100 && (await fixture()).files<2; i++) await sleep(40);
    assert.equal((await fixture()).files,2);
  } finally {
    child.kill('SIGKILL');
    await stopped;
  }
  // Сокращаем ожидание истечения lease после аварийного завершения процесса.
  await pool.query('UPDATE jarvis_runs SET due=now() WHERE id=$1 AND lease IS NOT NULL',[interrupted]);
  await cli('tick');
  const recovered = await cli('show',interrupted,actor);
  assert.equal(recovered.step,'submitted');
  assert.equal(recovered.revision,2);
  const replay = await fixture();
  assert.equal(replay.requests.length,3);
  assert.equal(replay.requests[1],replay.requests[2]);
  assert.notEqual(replay.requests[0],replay.requests[1]);
  assert.equal(replay.files,2);
  assert.equal(replay.history,2);

  const cancelled = await waitForChoice();
  await runner.act(cancelled,actor,'choose','cancel');
  assert.equal((await runner.view(cancelled,actor)).step,'cancelled');
  const expired = await waitForChoice();
  await pool.query("UPDATE jarvis_runs SET expires=now()-interval '1 second' WHERE id=$1",[expired]);
  await runner.tick();
  assert.equal((await runner.view(expired,actor)).step,'expired');
  assert.equal((await fixture()).files,2);

  const uncertain = await waitForChoice();
  await runner.act(uncertain,actor,'choose','select',{value:'rutor:2'});
  await fetch('http://filmobot:8080/fixture?fault=unavailable', { method: 'POST' });
  for (let attempt=1; attempt<=3; attempt++) {
    await runner.tick();
    if (attempt < 3) {
      const pending = await pool.query('SELECT due > now() + interval \'3 seconds\' AS delayed FROM jarvis_runs WHERE id=$1',[uncertain]);
      assert.equal(pending.rows[0].delayed,true);
      await pool.query('UPDATE jarvis_runs SET due=now() WHERE id=$1',[uncertain]);
    }
  }
  assert.equal((await runner.view(uncertain,actor)).step,'uncertain');
  const attempts = (await runner.history(uncertain,actor)).filter(row => row.step === 'enqueue');
  assert.deepEqual(attempts.map(row => row.attempt),[1,2,3]);
  assert.equal(new Set(attempts.map(row => row.request)).size,3);
  const final = await fixture();
  assert.equal(final.files,3);
  assert.equal(final.history,3);
  assert.equal(new Set(final.requests.slice(-3)).size,1);
  assert.ok(attempts.every(row => row.command === final.requests.at(-1)));
});
