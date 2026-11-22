import { loadCatalog } from './config/catalog.ts';
import { readJson } from './config/schema.ts';
import { validateWorkflow } from './config/workflow.ts';

const [connection, workflow] = process.argv.slice(2);
if (process.argv.length !== 4 || !connection || !workflow) {
  console.error('Использование: node src/validate.ts <connection.json> <workflow.json>');
  process.exitCode = 2;
} else {
  try {
    const catalog = await loadCatalog(connection);
    const graph = validateWorkflow(await readJson(workflow), catalog, workflow);
    console.log(`${catalog.service} v${catalog.major}: ${[...catalog.operations.keys()].join(', ')}`);
    console.log(`${graph.id} (ревизия ${graph.revision}): проверено узлов — ${graph.nodes}.`);
  } catch (error) {
    console.error(`Ошибка проверки ${connection}, ${workflow}: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
