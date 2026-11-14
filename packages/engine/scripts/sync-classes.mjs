// The data pipeline writes the calibrated classes to apps/web/public/data/classes.json (its
// tests read them there). The engine bundles an identical copy so defaultClasses() needs no
// fetch and the engine stays independent of the app. `--check` fails if the copies differ.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const src = resolve(here, '../../../apps/web/public/data/classes.json');
const dst = resolve(here, '../data/classes.json');
const a = readFileSync(src, 'utf8');
if (process.argv.includes('--check')) {
  let b = '';
  try {
    b = readFileSync(dst, 'utf8');
  } catch {}
  if (a !== b) {
    console.error('packages/engine/data/classes.json is out of date: run `pnpm sync-classes`');
    process.exit(1);
  }
  console.log('classes.json in sync');
} else {
  writeFileSync(dst, a);
  console.log('synced packages/engine/data/classes.json');
}
