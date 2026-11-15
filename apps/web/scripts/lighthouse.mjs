// Lighthouse with default mobile settings, using Playwright's Chromium; lighthouse@12 is fetched
// by npx (user-approved tool, not a project dependency).
//   pnpm lighthouse [url] [--runs N]     (default: the deployed site, 3 runs)
// Prints each run's performance / accessibility / best-practices scores and their medians.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from '@playwright/test';

const DEFAULT_URL = 'https://weave-simulator.vercel.app';
const args = process.argv.slice(2);
const runsAt = args.indexOf('--runs');
const runs = runsAt >= 0 ? Number(args[runsAt + 1]) : 3;
const url = args.find((a, i) => !a.startsWith('--') && i !== runsAt + 1) ?? DEFAULT_URL;
const chrome = chromium.executablePath();
const CATS = ['performance', 'accessibility', 'best-practices'];

const dir = mkdtempSync(join(tmpdir(), 'weave-lh-'));
const results = [];
try {
  for (let i = 1; i <= runs; i++) {
    const out = join(dir, `run${i}.json`);
    const r = spawnSync(
      'npx',
      ['-y', 'lighthouse@12', url, '--quiet', '--output=json', `--output-path=${out}`, `--only-categories=${CATS.join(',')}`, '--chrome-flags=--headless=new --no-sandbox'],
      { stdio: ['ignore', 'inherit', 'inherit'], env: { ...process.env, CHROME_PATH: chrome } },
    );
    if (r.status !== 0) throw new Error(`lighthouse run ${i} failed (exit ${r.status})`);
    const lhr = JSON.parse(readFileSync(out, 'utf8'));
    const s = Object.fromEntries(CATS.map((c) => [c, Math.round(lhr.categories[c].score * 100)]));
    results.push(s);
    console.log(`run ${i}: ${CATS.map((c) => `${c} ${s[c]}`).join(', ')}  (${lhr.lighthouseVersion}, ${lhr.configSettings.formFactor})`);
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}
const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor((xs.length - 1) / 2)];
console.log(`median of ${runs}: ${CATS.map((c) => `${c} ${median(results.map((r) => r[c]))}`).join(', ')}`);
