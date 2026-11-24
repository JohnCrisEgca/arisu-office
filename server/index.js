import { buildConfig, loadDotEnv } from './config.js';
import { createApp } from './app.js';

loadDotEnv();
const cfg = buildConfig();
const { server } = createApp(cfg);

server.listen(cfg.port, cfg.host, () => {
  console.log(`Arisu Office running at http://${cfg.host}:${cfg.port}`);
  if (!cfg.openaiKey || !cfg.model) console.log('  AI is OFF: set OPENAI_API_KEY and OPENAI_MODEL in .env to turn it on.');
  console.log(`  Facebook publishing: ${cfg.fbEnabled ? 'ON (approved posts can be published)' : 'OFF (approved posts are marked as posted manually)'}`);
  if (cfg.host !== '127.0.0.1' && !cfg.cookieSecure) console.log('  WARNING: serving beyond localhost without COOKIE_SECURE=true. Put it behind HTTPS.');
});
