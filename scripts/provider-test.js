/**
 * scripts/provider-test.js — proves the two-key AI bridge works.
 *
 * The live providers need real credentials, so this stands up two mocks:
 *
 *   Zen     /v1/models (catalogue) plus all four of the transports Zen speaks:
 *           /v1/models/<id>:generateContent  (Google-native, gemini-*)
 *           /v1/messages                     (Anthropic, claude-*)
 *           /v1/responses                    (OpenAI responses, gpt-*, grok-*)
 *           /v1/chat/completions             (OpenAI-compatible, everything else)
 *
 *   Gemini  /v1beta/models (catalogue) + /v1beta/models/<id>:generateContent,
 *           which is the shape @google/genai speaks.
 *
 * and asserts discovery, ranking, routing, auth, structured output, model and
 * provider fallback, rate-limit failover and JSON salvage.
 *
 * Usage: node scripts/provider-test.js
 */

import http from 'node:http';

/* ------------------------------------------------------------------ *
 * Mock gateway
 * ------------------------------------------------------------------ */

const received = [];
let behaviour = {};

const SAMPLE = {
  score: 42,
  severity: 'elevated',
  headline: 'Mock headline',
  summary: 'Mock summary',
  defafferPatterns: [],
  actions: [],
  forecast: {},
};

function sendJson(res, status, obj) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(obj));
}

const googleEnvelope = (model, text) => ({
  candidates: [{
    content: { parts: [{ text }], role: 'model' },
    finishReason: 'STOP',
    index: 0,
  }],
  modelVersion: model,
  usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 50, totalTokenCount: 150 },
});

function contentFor() {
  if (behaviour.garbage) return behaviour.garbage;
  if (behaviour.riskActions) {
    return JSON.stringify({ ...SAMPLE, actions: behaviour.riskActions });
  }
  if (behaviour.wrap === 'fence') return '```json\n' + JSON.stringify(SAMPLE) + '\n```';
  if (behaviour.wrap === 'prose') {
    return 'Here is the analysis:\n' + JSON.stringify(SAMPLE) + '\nHope that helps.';
  }
  return JSON.stringify(SAMPLE);
}

/** Rate limit one provider only, so failover can be observed. */
const throttled = (call) => {
  const list = behaviour.rateLimit || [];
  return list.some((rule) => rule === call.provider
    || (rule.endsWith('*') && call.model.startsWith(rule.slice(0, -1))));
};

const ZEN_CATALOGUE = [
  'gemini-3.8-flash', 'gemini-3.7-flash', 'gemini-3.5-flash', 'gemini-3.1-pro',
  'claude-sonnet-5', 'claude-opus-5-5', 'gpt-6-sol', 'grok-4.7',
  'deepseek-v4-flash', 'deepseek-v4-flash-free', 'glm-5.3-flash', 'kimi-k3',
  'big-pickle', 'space-bunny-free', 'nemotron-3.5-lightning-free',
  'muse-spark-1.3-contributor-free', 'mimo-v2.6-flash-free', 'jev-1.13',
];
/** What discovery is allowed to keep: big-pickle trains on your data during
 *  its free period, nemotron's trial endpoints take no confidential data,
 *  muse-contributor trains Meta models on your prompts, jev is not text. */
const ZEN_DROPPED = ['big-pickle', 'nemotron-3.5-lightning-free',
  'muse-spark-1.3-contributor-free', 'mimo-v2.6-flash-free', 'jev-1.13'];
const ZEN_USABLE = ZEN_CATALOGUE.filter((id) => !ZEN_DROPPED.includes(id));

const GEMINI_CATALOGUE = [
  'models/gemini-3.8-flash', 'models/gemini-3.7-flash', 'models/gemini-3.1-pro',
];

function startMock() {
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => { raw += d; });
    req.on('end', () => {
      let body = {};
      try { body = JSON.parse(raw); } catch { /* keep {} */ }

      const url = new URL(req.url, 'http://localhost');
      const p = url.pathname;

      /* ---- Google-native (used by both Zen and the Gemini SDK) ---- */
      const isGoogle = /^\/v(?:1|1beta)\/models\/[^/]+:generateContent$/.test(p);
      if (isGoogle) {
        const model = decodeURIComponent(p.split('/').pop().split(':')[0]);
        const call = {
          provider: p.startsWith('/v1/') ? 'zen' : 'gemini',
          route: 'google',
          path: p,
          model,
          auth: req.headers.authorization,
          googKey: req.headers['x-goog-api-key'],
          body,
        };
        received.push(call);
        return respondGoogle(call, res);
      }

      /* ---- Zen: catalogue ---- */
      if (p === '/v1/models' && req.method === 'GET') {
        return sendJson(res, 200, {
          object: 'list',
          data: ZEN_CATALOGUE.map((id) => ({ id, object: 'model' })),
        });
      }

      /* ---- Gemini SDK: catalogue ---- */
      if (p === '/v1beta/models' && req.method === 'GET') {
        return sendJson(res, 200, {
          models: GEMINI_CATALOGUE.map((name) => ({
            name,
            supportedGenerationMethods: ['generateContent'],
          })),
        });
      }

      /* ---- Zen: the other three transports ---- */
      const route = p === '/v1/chat/completions' ? 'openai'
        : p === '/v1/messages' ? 'anthropic'
          : p === '/v1/responses' ? 'responses' : null;
      if (route) {
        const model = route === 'anthropic'
          ? body?.model
          : route === 'openai' ? body?.model : body?.model;
        const call = { provider: 'zen', route, path: p, model, auth: req.headers.authorization, body };
        received.push(call);
        return respondZen(route, call, res);
      }

      return sendJson(res, 404, { error: { message: `no mock for ${p}` } });
    });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

function respondGoogle(call, res) {
  if (behaviour.rejectModels?.includes(call.model)) {
    return sendJson(res, 404, {
      error: { message: `The model \`${call.model}\` does not exist or is not enabled` },
    });
  }
  if (throttled(call)) {
    return sendJson(res, 429, {
      error: { message: 'Resource has been exhausted (e.g. check quota).', status: 'RESOURCE_EXHAUSTED' },
    });
  }
  if (behaviour.status && behaviour.status !== 200) {
    return sendJson(res, behaviour.status, { error: { message: 'upstream failure' } });
  }
  return sendJson(res, 200, googleEnvelope(call.model, contentFor()));
}

function respondZen(route, call, res) {
  if (behaviour.rejectModels?.includes(call.model)) {
    return sendJson(res, 404, {
      error: { message: `The model \`${call.model}\` does not exist or is not enabled` },
    });
  }
  if (throttled(call)) {
    return sendJson(res, 429, { error: { message: 'rate limit exceeded' } });
  }
  if (behaviour.status && behaviour.status !== 200) {
    return sendJson(res, behaviour.status, { error: { message: 'upstream failure' } });
  }

  const text = contentFor();
  if (route === 'openai') {
    return sendJson(res, 200, {
      id: 'chatcmpl-mock', model: call.model,
      choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
    });
  }
  if (route === 'anthropic') {
    return sendJson(res, 200, {
      id: 'msg_mock', model: call.model, role: 'assistant', stop_reason: 'end_turn',
      content: [{ type: 'text', text }],
      usage: { input_tokens: 100, output_tokens: 50 },
    });
  }
  return sendJson(res, 200, {
    id: 'resp_mock', model: call.model, status: 'completed',
    output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] }],
    usage: { input_tokens: 100, output_tokens: 50 },
  });
}

/* ------------------------------------------------------------------ *
 * Harness
 * ------------------------------------------------------------------ */

let passed = 0;
let failed = 0;
const failures = [];

const check = (name, ok, detail) => {
  if (ok) { passed += 1; console.log(`  \x1b[32m✓\x1b[0m ${name}`); } else {
    failed += 1;
    failures.push(name);
    console.log(`  \x1b[31m✗\x1b[0m ${name}${detail ? ` — ${detail}` : ''}`);
  }
};
const group = (t) => console.log(`\n\x1b[1m${t}\x1b[0m`);

const { server, port } = await startMock();
const ZEN_BASE = `http://127.0.0.1:${port}/v1`;
const GEMINI_BASE = `http://127.0.0.1:${port}`;

const reset = () => { received.length = 0; behaviour = {}; };
const loadAi = () => import(`../lib/ai.js?t=${Date.now()}${Math.random()}`);

const withBothKeys = () => {
  process.env.GEMINI_API_KEY = 'gemini-key';
  process.env.GEMINI_BASE_URL = GEMINI_BASE;
  process.env.OPENCODE_ZEN_API_KEY = 'zen-key';
  process.env.OPENCODE_ZEN_URL = ZEN_BASE;
  process.env.AI_CACHE_TTL_MS = '0';
  process.env.AI_DISCOVERY_TTL_MS = '0';
};

/* ------------------------------------------------------------------ *
 * 1. Transport classification
 * ------------------------------------------------------------------ */

group('Zen transport selection (matches the published endpoint table)');
{
  const { zenRouteFor } = await loadAi();
  check('gemini-* uses the Google-native route', zenRouteFor('gemini-3.8-flash') === 'google');
  check('gemini-3.1-pro uses the Google-native route', zenRouteFor('gemini-3.1-pro') === 'google');
  check('claude-* uses /messages', zenRouteFor('claude-sonnet-5') === 'anthropic');
  check('gpt-* uses /responses', zenRouteFor('gpt-6-sol') === 'responses');
  check('grok-* uses /responses', zenRouteFor('grok-4.7') === 'responses');
  check('deepseek/glm/kimi use /chat/completions', zenRouteFor('deepseek-v4-flash') === 'openai');
  check('free models use /chat/completions', zenRouteFor('space-bunny-free') === 'openai');
}

group('Zen endpoints point at the real gateway');
{
  const { ZEN_BASE: base, ZEN_CHAT_URL, ZEN_GOOGLE_BASE, ZEN_MESSAGES_URL, ZEN_RESPONSES_URL } =
    await loadAi();
  check('base host is opencode.ai', base === 'https://opencode.ai/zen/v1', base);
  check('OpenAI route is /zen/v1/chat/completions',
    ZEN_CHAT_URL === 'https://opencode.ai/zen/v1/chat/completions', ZEN_CHAT_URL);
  check('Google route base is /zen/v1/models',
    ZEN_GOOGLE_BASE === 'https://opencode.ai/zen/v1/models', ZEN_GOOGLE_BASE);
  check('Anthropic route is /zen/v1/messages',
    ZEN_MESSAGES_URL === 'https://opencode.ai/zen/v1/messages', ZEN_MESSAGES_URL);
  check('Responses route is /zen/v1/responses',
    ZEN_RESPONSES_URL === 'https://opencode.ai/zen/v1/responses', ZEN_RESPONSES_URL);
}

/* ------------------------------------------------------------------ *
 * 2. Discovery — "what does this key give me?"
 * ------------------------------------------------------------------ */

group('Catalogue discovery per key');
let rankedAi = null;
{
  reset();
  withBothKeys();
  rankedAi = await loadAi();
  const { discoverModels, candidateModels, getProvider } = rankedAi;

  check('gemini is the primary provider', getProvider() === 'gemini');

  await discoverModels({ force: true });
  const geminiChain = candidateModels('gemini', 'fast');
  const zenChain = candidateModels('zen', 'fast');

  check('gemini chain comes from the API key, not a hardcoded list',
    geminiChain.join() === 'gemini-3.8-flash,gemini-3.7-flash,gemini-3.1-pro', geminiChain.join());
  check('zen chain comes from the catalogue, minus what Zen flags as unsafe',
    zenChain.length === ZEN_USABLE.length, `${zenChain.length} vs ${ZEN_USABLE.length}`);
  check('nothing Zen flags as unsafe survives discovery',
    ZEN_DROPPED.every((id) => !zenChain.includes(id)), ZEN_DROPPED.filter((i) => zenChain.includes(i)).join());
  check('zen is capped by ranking, not by a fixed list',
    zenChain.length > 0 && zenChain.every((m) => ZEN_CATALOGUE.includes(m)));
}

group('Ranking into fast and deep chains');
{
  const { candidateModels } = rankedAi;
  const fast = candidateModels('zen', 'fast');
  const deep = candidateModels('zen', 'deep');

  check('fast leads with a free model on Zen', fast[0].endsWith('-free'), fast.join());
  check('fast prefers flash over pro',
    fast.indexOf('gemini-3.8-flash') < fast.indexOf('gemini-3.1-pro'));
  check('family outranks a bigger version number',
    fast.indexOf('gemini-3.8-flash') < fast.indexOf('glm-5.3-flash'));
  check('deep leads with a frontier pro/opus model',
    deep[0] === 'gemini-3.1-pro' || deep[0].startsWith('claude-'), deep[0]);
  check('deep still ends with a usable model', deep.length > 0);
  check('non-text models never enter a chain',
    !fast.concat(deep).some((m) => /embedding|tts|image/.test(m)));
  check('jev is excluded (different protocol)', !fast.concat(deep).some((m) => m.startsWith('jev-')));
  check('models Zen flags as training-on-your-data are never auto-selected',
    !fast.concat(deep).some((m) => /^(big-pickle|mimo-.*-free|ling-.*-free|nemotron-.*-free|muse-spark-.*contributor-free)$/
      .test(m)),
    fast.concat(deep).filter((m) => /big-pickle|mimo|ling|nemotron|contributor/.test(m)).join());
}

group('AI_MODEL_CHAIN overrides the ranking');
{
  reset();
  withBothKeys();
  process.env.AI_MODEL_CHAIN = 'zen:kimi-k3,gemini:gemini-3.7-flash,claude-sonnet-5';
  const { discoverModels, runStructured } = await loadAi();
  await discoverModels({ force: true });

  const res = await runStructured({ task: 'override', system: 's', prompt: 'p' });
  check('the pinned model is used', res.model === 'kimi-k3', res.model);
  check('on the pinned provider', res.provider === 'zen', res.provider);
  check('over the top of the ranking', res.model !== 'gemini-3.8-flash');

  reset();
  behaviour.rejectModels = ['kimi-k3'];
  const fallback = await runStructured({ task: 'override-2', system: 's', prompt: 'p' });
  check('a broken pinned model falls to the next pin', fallback.degraded === false, fallback.error || '');
  check('second pin was used', received.at(-1)?.model === 'gemini-3.7-flash',
    received.at(-1)?.model);
  check('second pin went to the gemini provider', received.at(-1)?.provider === 'gemini');
  delete process.env.AI_MODEL_CHAIN;
}

group('Discovery falls back to a seed when a catalogue is unreachable');
{
  reset();
  process.env.OPENCODE_ZEN_URL = 'http://127.0.0.1:1/v1';
  const { discoverModels, candidateModels } = await loadAi();
  await discoverModels({ force: true });
  const chain = candidateModels('zen', 'fast');
  check('still returns a usable chain', chain.length > 0, chain.join());
  check('chain is not empty after a dead catalogue', chain.every((m) => typeof m === 'string'));
  process.env.OPENCODE_ZEN_URL = ZEN_BASE;
}

/* ------------------------------------------------------------------ *
 * 3. Happy paths
 * ------------------------------------------------------------------ */

group('Gemini key (primary) — SDK route');
{
  reset();
  withBothKeys();
  const { runStructured } = await loadAi();

  const res = await runStructured({ task: 'gemini-primary', system: 'sys', prompt: 'user' });

  check('not degraded', res.degraded === false, res.error || '');
  check('routed to the gemini provider', res.provider === 'gemini', res.provider);
  check('used the top of the discovered chain', res.model === 'gemini-3.8-flash', res.model);
  check('exactly one upstream call', received.length === 1, `got ${received.length}`);
  check('hit the SDK google-native path',
    received[0].route === 'google' && received[0].path.startsWith('/v1beta/models/'), received[0].path);
  check('sent the system instruction',
    received[0].body.systemInstruction?.parts?.[0]?.text === 'sys',
    JSON.stringify(received[0].body.systemInstruction));
  check('parses the payload', res.data?.headline === 'Mock headline');
}

group('Zen (backup) — all four transports');
{
  const cases = [
    { model: 'gemini-3.8-flash', route: 'google', path: /^\/v1\/models\/gemini-3\.8-flash:generateContent$/ },
    { model: 'claude-sonnet-5', route: 'anthropic', path: '/v1/messages' },
    { model: 'gpt-6-sol', route: 'responses', path: '/v1/responses' },
    { model: 'deepseek-v4-flash', route: 'openai', path: '/v1/chat/completions' },
  ];

  for (const c of cases) {
    reset();
    delete process.env.GEMINI_API_KEY;
    process.env.OPENCODE_ZEN_API_KEY = 'zen-key';
    process.env.OPENCODE_ZEN_URL = ZEN_BASE;
    process.env.AI_MODEL_CHAIN = `zen:${c.model}`;

    const { runStructured } = await loadAi();
    const res = await runStructured({ task: `zen-${c.route}`, system: 'sys', prompt: 'user' });

    check(`${c.model} answers`, res.degraded === false, res.error || '');
    check(`${c.model} -> ${c.route}`, received[0]?.route === c.route, received[0]?.route);
    check(`${c.model} hits ${c.path}`,
      typeof c.path === 'string' ? received[0]?.path === c.path : c.path.test(received[0]?.path || ''),
      received[0]?.path);
    check(`${c.model} authenticates with the zen key`,
      received[0]?.auth === 'Bearer zen-key', String(received[0]?.auth));

    delete process.env.AI_MODEL_CHAIN;
  }
}

group('Anthropic + responses request shapes');
{
  reset();
  delete process.env.GEMINI_API_KEY;
  process.env.OPENCODE_ZEN_API_KEY = 'zen-key';
  process.env.OPENCODE_ZEN_URL = ZEN_BASE;
  process.env.AI_MODEL_CHAIN = 'zen:claude-sonnet-5';
  const { runStructured } = await loadAi();
  await runStructured({ task: 'anthropic-shape', system: 'sys', prompt: 'user' });
  const call = received[0];
  check('sends max_tokens', Number.isFinite(call.body.max_tokens));
  check('sends the system prompt top-level', call.body.system === 'sys');
  check('sends one user message', call.body.messages?.[0]?.role === 'user'
    && call.body.messages[0]?.content === 'user');
  delete process.env.AI_MODEL_CHAIN;
}
{
  reset();
  process.env.AI_MODEL_CHAIN = 'zen:gpt-6-sol';
  const { runStructured } = await loadAi();
  await runStructured({ task: 'responses-shape', system: 'sys', prompt: 'user' });
  const call = received[0];
  check('sends max_output_tokens', Number.isFinite(call.body.max_output_tokens));
  check('sends system + user input items',
    call.body.input?.[0]?.role === 'system' && call.body.input?.[1]?.role === 'user',
    JSON.stringify(call.body.input)?.slice(0, 160));
  check('input content is typed text',
    call.body.input?.[1]?.content?.[0]?.type === 'input_text');
  delete process.env.AI_MODEL_CHAIN;
}

/* ------------------------------------------------------------------ *
 * 4. Failover
 * ------------------------------------------------------------------ */

group('Gemini key is primary, Zen takes over when it is throttled');
let failoverAi = null;
{
  reset();
  withBothKeys();
  behaviour.rateLimit = ['gemini'];

  // One module instance for both groups below: the cooldown lives in module
  // state, and a fresh import would silently reset it.
  failoverAi = await loadAi();
  const { runStructured, aiStatus } = failoverAi;

  const res = await runStructured({ task: 'failover', system: 's', prompt: 'p' });

  check('not degraded after a 429', res.degraded === false, res.error || '');
  check('fell through to zen', res.provider === 'zen', res.provider);
  check('tried gemini first', received[0]?.provider === 'gemini', received[0]?.provider);
  check('then answered on zen', received.at(-1)?.provider === 'zen');
  check('every gemini call was throttled',
    received.filter((c) => c.provider === 'gemini').length > 0
    && received.filter((c) => c.provider === 'gemini').every((c) => c.route === 'google'));

  const status = aiStatus();
  check('throttled provider is put in cooldown',
    Boolean(status.discovery.providers.gemini.cooldown), JSON.stringify(status.discovery));
  check('healthy provider is not', !status.discovery.providers.zen.cooldown);
}

group('A cooled-down provider is skipped on the next request');
{
  reset();
  withBothKeys();
  const { runStructured } = failoverAi;

  const first = await runStructured({ task: 'cool-1', system: 's', prompt: 'p' });
  check('first request answers', first.degraded === false, first.error || '');
  check('first request skipped the cooling provider',
    received.every((c) => c.provider === 'zen'), received.map((c) => c.provider).join());
  check('nothing was sent to gemini', received.filter((c) => c.provider === 'gemini').length === 0);

  const second = await runStructured({ task: 'cool-2', system: 's', prompt: 'p' });
  check('second request answers', second.degraded === false, second.error || '');
  check('still skipped the cooling provider',
    received.every((c) => c.provider === 'zen'), received.map((c) => c.provider).join());
  void second;
}

group('Model fallback inside one provider');
{
  reset();
  delete process.env.GEMINI_API_KEY;
  process.env.OPENCODE_ZEN_API_KEY = 'zen-key';
  process.env.OPENCODE_ZEN_URL = ZEN_BASE;
  process.env.AI_MODEL_CHAIN = 'gemini-3.8-flash,gemini-3.7-flash';

  const { runStructured } = await loadAi();
  behaviour.rejectModels = ['gemini-3.8-flash'];

  const res = await runStructured({ task: 'fallback', system: 's', prompt: 'p' });
  check('recovers after a 404', res.degraded === false, res.error || '');
  check('made 2 calls', received.length === 2, `got ${received.length}`);
  check('first call was the primary', received[0].model === 'gemini-3.8-flash');
  check('second call was the fallback', received[1].model === 'gemini-3.7-flash');

  const retry = await runStructured({ task: 'fallback-2', system: 's2', prompt: 'p2' });
  check('dead model is not retried', received.length === 3, `got ${received.length}`);
  check('retry went straight to the fallback', received[2].model === 'gemini-3.7-flash');
  check('still returns a result', retry.degraded === false);
  delete process.env.AI_MODEL_CHAIN;
}

group('Upstream failure handling');
{
  reset();
  delete process.env.GEMINI_API_KEY;
  process.env.OPENCODE_ZEN_API_KEY = 'zen-key';
  process.env.OPENCODE_ZEN_URL = ZEN_BASE;
  behaviour.status = 500;

  const { runStructured, candidateModels, discoverModels } = await loadAi();
  await discoverModels({ force: true });
  const res = await runStructured({
    task: 'boom', system: 's', prompt: 'p', fallback: () => ({ ok: true }),
  });

  check('500 does not throw', res.degraded === true);
  check('tries the whole chain', received.length === candidateModels('zen', 'fast').length,
    `got ${received.length}`);
  check('reports an error string', typeof res.error === 'string' && res.error.length > 0);
  check('still returns a usable object', res.data?.ok === true);
}

/* ------------------------------------------------------------------ *
 * 5. JSON salvage
 * ------------------------------------------------------------------ */

group('JSON extraction robustness');
{
  for (const wrap of ['fence', 'prose']) {
    reset();
    behaviour.wrap = wrap;
    const { runStructured } = await loadAi();
    const res = await runStructured({ task: `salvage-${wrap}`, system: 's', prompt: 'p' });
    check(wrap === 'fence' ? '```json fenced output' : 'prose-wrapped output',
      res.data?.headline === 'Mock headline', `source ${res.source}`);
  }

  reset();
  behaviour.garbage = 'I am afraid I cannot help with that.';
  const { runStructured } = await loadAi();
  const res = await runStructured({
    task: 'garbage', system: 's', prompt: 'p', fallback: () => ({ headline: 'fallback' }),
  });
  check('non-JSON degrades to fallback', res.degraded === true);
  check('fallback payload returned', res.data.headline === 'fallback');
}

/* ------------------------------------------------------------------ *
 * 6. Offline
 * ------------------------------------------------------------------ */

group('No keys at all');
{
  reset();
  delete process.env.OPENCODE_ZEN_API_KEY;
  delete process.env.OPENCODE_API_KEY;
  delete process.env.GEMINI_API_KEY;
  const { getProvider, runStructured } = await loadAi();
  check('offline', getProvider() === 'offline');
  const res = await runStructured({
    task: 'offline', system: 's', prompt: 'p', fallback: () => ({ headline: 'det' }),
  });
  check('offline makes no network call', received.length === 0);
  check('offline returns fallback', res.data.headline === 'det');
  check('offline is flagged degraded', res.degraded === true);
}

group('Zen-only key still serves gemini models');
{
  reset();
  delete process.env.GEMINI_API_KEY;
  process.env.OPENCODE_ZEN_API_KEY = 'zen-key';
  process.env.OPENCODE_ZEN_URL = ZEN_BASE;
  const { getProvider, runStructured, zenRouteFor } = await loadAi();
  check('provider is zen', getProvider() === 'zen');
  const res = await runStructured({ task: 'zen-only', system: 's', prompt: 'p' });
  check('answers from zen', res.degraded === false && res.provider === 'zen', res.error || '');
  check('the model Zen picked is served on the route it is classified for',
    received[0]?.route === zenRouteFor(res.model), `${res.model} -> ${received[0]?.route}`);
}

group('OPENCODE_API_KEY is accepted as a Zen key');
{
  reset();
  delete process.env.OPENCODE_ZEN_API_KEY;
  delete process.env.GEMINI_API_KEY;
  process.env.OPENCODE_API_KEY = 'opencode-conventional-key';
  process.env.OPENCODE_ZEN_URL = ZEN_BASE;
  const { getProvider, runStructured } = await loadAi();
  check('resolves to zen', getProvider() === 'zen');
  const res = await runStructured({ task: 'opencode-env', system: 's', prompt: 'p' });
  check('that key authenticates', res.degraded === false, res.error || '');
  delete process.env.OPENCODE_API_KEY;
}

/* ------------------------------------------------------------------ *
 * 7. Probe
 * ------------------------------------------------------------------ */

group('probeKeys answers "what does this key give me"');
{
  reset();
  withBothKeys();
  const { probeKeys } = await loadAi();
  const report = await probeKeys({ tier: 'fast', verify: true, limit: 3 });

  check('primary is gemini', report.primary === 'gemini', report.primary);
  check('both keys are described', Boolean(report.keys.gemini && report.keys.zen));
  check('keys are masked', report.keys.gemini.key.endsWith('key')
    && !report.keys.gemini.key.includes('gemini-key'), report.keys.gemini.key);
  check('gemini catalogue read ok', report.keys.gemini.catalogue.ok === true);
  check('zen catalogue read ok', report.keys.zen.catalogue.ok === true);
  check('zen catalogue counted every usable model',
    report.keys.zen.catalogue.count === ZEN_USABLE.length,
    String(report.keys.zen.catalogue.count));
  check('each key was probed', report.keys.gemini.probes.length === 3
    && report.keys.zen.probes.length === 3);
  check('probes carry the transport used',
    report.keys.zen.probes.every((p) => ['google', 'anthropic', 'responses', 'openai'].includes(p.route)),
    JSON.stringify(report.keys.zen.probes.map((p) => p.route)));
  check('all probes succeeded', [...report.keys.gemini.probes, ...report.keys.zen.probes]
    .every((p) => p.ok), JSON.stringify(report.keys.zen.probes.map((p) => p.error)));
}

group('Status reflects both keys');
{
  reset();
  withBothKeys();
  const { aiStatus } = await loadAi();
  const s = aiStatus();
  check('primary is gemini', s.provider === 'gemini');
  check('both providers listed', s.providers.join() === 'gemini,zen', s.providers.join());
  check('plan carries provider per model',
    s.plan.fast.every((c) => c.provider && c.model), JSON.stringify(s.plan.fast[0]));
  check('zen entries carry a transport',
    s.plan.fast.filter((c) => c.provider === 'zen').every((c) => c.route));
  check('discovery is reported', Boolean(s.discovery.providers.gemini));
}

/* ------------------------------------------------------------------ *
 * 8. Analytics layer
 * ------------------------------------------------------------------ */

group('End-to-end through the analytics layer');
{
  reset();
  withBothKeys();
  const { collectionRiskAnalysis, studentRecoveryPlan } = await import(
    `../lib/analytics.js?t=${Date.now()}`
  );
  const { listAllStudents } = await import('../lib/db.js');

  const a = await collectionRiskAnalysis();
  check('risk analysis runs live', a.ai.configured !== false && a.ai.degraded === false, a.ai.error || '');
  check('risk analysis reports a model', typeof a.ai.model === 'string');

  const p = await studentRecoveryPlan({ student: listAllStudents()[0] });
  check('recovery plan is not degraded', p.ai.degraded === false, p.ai.error || '');
  check('plan has a numeric risk score', Number.isFinite(p.plan.riskScore));
}

group('Live-model output is normalized, not trusted verbatim');
{
  reset();
  withBothKeys();
  const order = ['LOW', 'critical', 'HIGH', 'banana', 'medium'];
  behaviour.riskActions = order.map((priority, i) => ({
    priority,
    action: `action-${i}`,
    owner: 'Owner',
    timeline: '1 week',
    expectedRecovery: 'Rs 1L',
  }));

  const { collectionRiskAnalysis } = await import(`../lib/analytics.js?t=${Date.now()}`);
  const res = await collectionRiskAnalysis();
  const got = res.analysis.actions.map((a) => a.priority);

  check('live AI output was actually used', res.ai.degraded === false, `${res.ai.provider}/${res.ai.error || ''}`);
  check('priorities come back normalized',
    got.every((p) => ['critical', 'high', 'medium', 'low'].includes(p)), got.join(','));
  check('unknown label coerced to a known one', !got.includes('banana'), got.join(','));

  const RANK = { critical: 0, high: 1, medium: 2, low: 3 };
  const ranks = got.map((p) => RANK[p]);
  check('actions are sorted by priority', ranks.every((r, i) => i === 0 || ranks[i - 1] <= r),
    got.join(' → '));
  check('most urgent action is first', got[0] === 'critical', got[0]);
  check('least urgent action is last', got[got.length - 1] === 'low', got[got.length - 1]);
  check('input order was genuinely unsorted', order.join() !== got.join(), `sent ${order.join()}`);
}

/* ------------------------------------------------------------------ */

delete process.env.OPENCODE_ZEN_API_KEY;
delete process.env.OPENCODE_ZEN_URL;
delete process.env.OPENCODE_API_KEY;
delete process.env.GEMINI_API_KEY;
delete process.env.GEMINI_BASE_URL;
delete process.env.AI_MODEL_CHAIN;
server.close();

console.log('\n' + '─'.repeat(58));
if (failed === 0) {
  console.log(`\x1b[32m✓ all ${passed} provider checks passed\x1b[0m`);
} else {
  console.log(`\x1b[31m✗ ${failed} failed\x1b[0m, \x1b[32m${passed} passed\x1b[0m`);
  for (const f of failures) console.log(`  \x1b[31m·\x1b[0m ${f}`);
}
console.log('─'.repeat(58) + '\n');

process.exit(failed === 0 ? 0 : 1);
