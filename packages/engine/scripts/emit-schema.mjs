// Emits the zod contract as JSON Schema into docs/ so the Python pipeline validates against the
// same contract. Run with: pnpm emit-schema (Node >= 24 strips the TS types on import).
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { Network, ClassSet, Scenario } from '../src/schema/index.ts';

const here = dirname(fileURLToPath(import.meta.url));
const out = resolve(here, '../../../docs/schema');
mkdirSync(out, { recursive: true });

const targets = { network: Network, classes: ClassSet, scenario: Scenario };
for (const [name, schema] of Object.entries(targets)) {
  // io: 'input' so fields with defaults are optional, matching what producers may omit.
  const json = z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' });
  writeFileSync(resolve(out, `${name}.schema.json`), JSON.stringify(json, null, 2) + '\n');
  console.log(`wrote docs/schema/${name}.schema.json`);
}
