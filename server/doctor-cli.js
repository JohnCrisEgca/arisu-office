// npm run doctor : checks your real OpenAI key, model and Facebook tokens from the command line.
import { buildConfig, loadDotEnv } from './config.js';
import { openDb } from './db.js';
import { createAi } from './ai.js';
import { runChecks } from './doctor.js';

loadDotEnv();
const cfg = buildConfig();
const results = await runChecks({ cfg, db: openDb(cfg.dbPath), ai: createAi(cfg) });
const icon = { pass: 'PASS', fail: 'FAIL', warn: 'WARN', skip: 'SKIP', info: 'INFO' };
for (const r of results) console.log(`${icon[r.status] ?? r.status}  ${r.name}: ${r.detail}`);
process.exit(results.some((r) => r.status === 'fail') ? 1 : 0);
