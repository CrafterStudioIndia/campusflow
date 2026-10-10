/**
 * scripts/ai-probe.js — "which model does this key actually give me?"
 *
 * Reads the two keys out of .env, asks each provider what it serves, ranks the
 * answer into fast/deep chains, and then sends one real request to the top of
 * every chain so the result is measured, not assumed.
 *
 * Usage:
 *   npm run ai:probe
 *   node scripts/ai-probe.js --tier deep --verify false
 */

import { probeKeys, aiStatus } from '../lib/ai.js';

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : process.argv[i + 1];
};

const tier = arg('tier', 'fast') === 'deep' ? 'deep' : 'fast';
const verify = arg('verify', 'true') !== 'false';
const limit = Number.parseInt(arg('limit', '5'), 10) || 5;

const dim = (s) => `\x1b[2m${s}\x1b[0m`;
const bold = (s) => `\x1b[1m${s}\x1b[0m`;
const green = (s) => `\x1b[32m${s}\x1b[0m`;
const red = (s) => `\x1b[31m${s}\x1b[0m`;

const status = aiStatus();
if (!status.configured) {
  console.log(red('\n  No keys configured. Add GEMINI_API_KEY and/or OPENCODE_ZEN_API_KEY to .env.\n'));
  process.exit(1);
}

console.log(`\n  ${bold('CampusFlow AI probe')} ${dim(`· tier ${tier} · ${verify ? 'verifying' : 'catalogue only'}`)}\n`);

const result = await probeKeys({ tier, verify, limit });

for (const [provider, info] of Object.entries(result.keys)) {
  const cat = info.catalogue;
  console.log(`  ${bold(provider.toUpperCase())} ${dim(info.key)}`);

  if (info.probes.length) {
    for (const p of info.probes) {
      const mark = p.ok ? green('✓') : red('✗');
      const why = p.ok ? dim(`${p.latencyMs}ms`) : red(p.error.slice(0, 90));
      console.log(`    ${mark} ${p.model.padEnd(28)} ${dim(p.route.padEnd(9))} ${why}`);
    }
  }

  const live = info.probes.filter((p) => p.ok).length;
  if (info.probes.length) {
    console.log(`    ${live}/${info.probes.length} answered`
      + (live < info.probes.length ? dim(' — the rest are dropped from the chain automatically') : ''));
  }
  if (!cat.ok) console.log(dim(`    catalogue: ${cat.error}`));
  console.log(dim(`    ${cat.count} models available · chain: ${info.chain.slice(0, 8).join(', ')}`));
  console.log('');
}

console.log(dim('  Routing: gemini-* via the Gemini key first, Zen behind it for everything else'
  + ' and for failover.\n'));
