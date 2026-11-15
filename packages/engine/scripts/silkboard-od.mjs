// Silk Board preset demand = the original plausible (not observed) OD, 125 veh/h per entry lane,
// about 2,950 veh/h (commit a9b56d6), with every row scaled by FACTOR and rounded to 1 veh/h.
// usage: node scripts/silkboard-od.mjs <factor> [--write]   (run inside the git repo)
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
const f = Number(process.argv[2]);
if (!(f > 0)) throw new Error('usage: silkboard-od.mjs <factor> [--write]');
const path = 'packages/engine/src/scenarios/silkboard-od.ts';
const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
const ref = execFileSync('git', ['show', `a9b56d6:${path}`], { encoding: 'utf8', cwd: root });
// The reference is a TS array literal (unquoted keys) from our own repository history.
const rows = new Function(`return ${ref.slice(ref.indexOf('= [', ref.indexOf('SILKBOARD_OD')) + 2, ref.lastIndexOf(']') + 1)}`)();
const od = rows.map((r) => ({ ...r, rateVph: Math.round(r.rateVph * f) })).filter((r) => r.rateVph > 0);
console.log(`factor ${f}: ${od.length} OD rows, ${od.reduce((a, x) => a + x.rateVph, 0)} veh/h`);
if (process.argv.includes('--write')) {
  const p = `${root}/${path}`;
  const head = fs.readFileSync(p, 'utf8').split('export const SILKBOARD_OD')[0];
  fs.writeFileSync(p, `${head}export const SILKBOARD_OD: OdEntry[] = ${JSON.stringify(od, null, 2)};\n`);
}
