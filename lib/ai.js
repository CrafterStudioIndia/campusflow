/**
 * lib/ai.js — provider-agnostic AI bridge.
 *
 * Two keys, nothing else to configure:
 *
 *   GEMINI_API_KEY       primary. Gemini models, via Google's own SDK.
 *   OPENCODE_ZEN_API_KEY backup. Every model Zen can serve, across the four
 *                        protocols Zen exposes (Google-native, Anthropic
 *                        /messages, OpenAI /responses, OpenAI-compatible
 *                        /chat/completions).
 *
 * Nothing about *which* models you get is hardcoded. On boot the bridge asks
 * each provider what it actually serves for the key it holds, ranks the answer
 * into a `fast` and a `deep` chain, and remembers the result. The model ids
 * you see in /api/health are the ones that key can really call — `probeKeys()`
 * goes one step further and actually sends a request to each one. Set
 * AI_MODEL_CHAIN to `provider:model,...` to override the ranking by hand.
 *
 * Routing, in order:
 *   1. whichever key AI_PROVIDER_ORDER ranks first, using its discovered
 *      chain for the requested tier
 *   2. the other key behind it, so a throttled or mis-scoped primary degrades
 *      to the backup instead of failing the request
 *   3. any provider that returns 429 is put in cooldown and the run continues
 *      on the next candidate
 *
 * `AI_PROVIDER_ORDER` defaults to `auto` (Gemini first, Zen as the net) and can
 * also pin one key to the front, or restrict routing to exactly one of them.
 *
 * Every task goes through `runStructured()`, which guarantees:
 *   - a JSON object back, no matter what the model emits
 *   - a bounded latency (hard timeout, no hanging requests)
 *   - automatic model + provider fallback
 *   - a graceful offline answer when no key is configured
 *   - provider/model provenance attached to the result for the UI
 */

import { GoogleGenAI } from '@google/genai';

/* ------------------------------------------------------------------ *
 * Endpoints
 * ------------------------------------------------------------------ */

const ZEN_BASE = (process.env.OPENCODE_ZEN_URL || 'https://opencode.ai/zen/v1')
  .replace(/\/+$/, '');

/** Zen speaks four protocols; see ZEN_ROUTES below. */
const ZEN_CHAT_URL = `${ZEN_BASE}/chat/completions`;
const ZEN_MESSAGES_URL = `${ZEN_BASE}/messages`;
const ZEN_RESPONSES_URL = `${ZEN_BASE}/responses`;
const ZEN_GOOGLE_BASE = `${ZEN_BASE}/models`;
/** Public model catalogue, same URL, GET instead of POST. */
const ZEN_MODELS_URL = ZEN_GOOGLE_BASE;

/** Overridable so tests can point the SDK at a local mock. */
const GEMINI_BASE_URL = (process.env.GEMINI_BASE_URL || '').replace(/\/+$/, '');

const DEFAULT_TIER = process.env.AI_TIER === 'deep' ? 'deep' : 'fast';
const REQUEST_TIMEOUT_MS = Number.parseInt(process.env.AI_TIMEOUT_MS || '25000', 10);
const DISCOVERY_TTL_MS = Number.parseInt(process.env.AI_DISCOVERY_TTL_MS || '900000', 10);
const RATE_LIMIT_COOLDOWN_MS = Number.parseInt(process.env.AI_RATE_LIMIT_COOLDOWN_MS || '60000', 10);
const BAD_KEY_COOLDOWN_MS = 10 * 60 * 1000;

/* ------------------------------------------------------------------ *
 * Credentials
 * ------------------------------------------------------------------ */

/** @type {'gemini'|'zen'|'offline'} */
export function getProvider() {
  const first = activeProviders()[0];
  return first || 'offline';
}

const geminiKey = () => (process.env.GEMINI_API_KEY || '').trim() || null;
const zenKey = () => (process.env.OPENCODE_ZEN_API_KEY || process.env.OPENCODE_API_KEY || '').trim()
  || null;

/**
 * How the two keys are ranked against each other.
 *
 * `auto` is the historical behaviour: Gemini first, Zen as the safety net.
 * The explicit orders let an operator flip that — some deployments pay for
 * Zen and want it to lead, others want Gemini's quota protected by refusing
 * Zen entirely rather than letting it absorb the overflow.
 * @returns {'auto'|'gemini-first'|'zen-first'|'gemini-only'|'zen-only'}
 */
export function providerOrder() {
  const raw = String(process.env.AI_PROVIDER_ORDER || 'auto').trim().toLowerCase();
  return ['auto', 'gemini-first', 'zen-first', 'gemini-only', 'zen-only'].includes(raw) ? raw : 'auto';
}

/** Configured providers, in the order they should be tried. */
export function activeProviders() {
  const configured = [];
  if (geminiKey()) configured.push('gemini');
  if (zenKey()) configured.push('zen');

  switch (providerOrder()) {
    case 'gemini-only':
      return configured.filter((p) => p === 'gemini');
    case 'zen-only':
      return configured.filter((p) => p === 'zen');
    case 'zen-first':
      return configured.reverse();
    case 'gemini-first':
      return ['gemini', 'zen'].filter((p) => configured.includes(p));
    default:
      return configured;
  }
}

/**
 * Every configured provider, including any the current order has switched off.
 * Reporting must never hide a key just because routing is ignoring it.
 */
function configuredProviders() {
  const out = [];
  if (geminiKey()) out.push('gemini');
  if (zenKey()) out.push('zen');
  return out;
}

const keyFor = (provider) => (provider === 'gemini' ? geminiKey() : zenKey());

/* ------------------------------------------------------------------ *
 * Which transport serves which model
 *
 * Taken from https://opencode.ai/docs/zen (the endpoint column). Order
 * matters: the first match wins, the last entry is the catch-all.
 * ------------------------------------------------------------------ */

const ZEN_ROUTES = [
  { match: /^gemini-/, route: 'google' },
  {
    match: /^(claude-|qwen3\.8-flash$|qwen3\.7-(max|plus)$|qwen3\.6-plus$|qwen3\.5-plus$)/,
    route: 'anthropic',
  },
  { match: /^(gpt-|grok-|muse-spark)/, route: 'responses' },
  { match: /./, route: 'openai' },
];

/** Zen serves Gemini on the Google-native route, everything else elsewhere. */
export function zenRouteFor(model) {
  const id = String(model).toLowerCase();
  return ZEN_ROUTES.find((r) => r.match.test(id)).route;
}

/** Jev speaks its own protocol (/systemone) and is not a text generator. */
const isUsableZenModel = (id) => !/^jev-/.test(id);

/**
 * Zen's own privacy notes flag a few free models as unsuitable for anything
 * holding real records: some train on your prompts during their free period,
 * and the Nemotron trial endpoints say not to send personal or confidential
 * data. CampusFlow analyses student records, so these are never auto-selected
 * — pick one explicitly via ZEN_MODEL_CHAIN if you disagree.
 * Source: https://opencode.ai/docs/zen (Privacy)
 */
const EXCLUDED_ZEN_MODELS = [
  /^big-pickle$/,
  /^mimo-.*-free$/,
  /^ling-.*-free$/,
  /^nemotron-.*-free$/,
  /^muse-spark-.*-contributor-free$/,
];

const isSafeZenModel = (id) => isUsableZenModel(id)
  && !EXCLUDED_ZEN_MODELS.some((re) => re.test(String(id).toLowerCase()));

/* ------------------------------------------------------------------ *
 * Ranking a catalogue into fast / deep chains
 *
 * Model ids are the only signal available, so rank on their shape: family
 * markers decide the tier, the version number orders within it, and Zen's
 * free tier wins on `fast` so the backup provider does not burn credits.
 * ------------------------------------------------------------------ */

const FAST_RE = /(flash|lite|mini|nano|haiku|spark|turbo|air|swift)/;
const DEEP_RE = /(pro|opus|sonnet|fable|ultra|max|plus|reason|think|frontier)/;
/** Not text-in/text-out. */
const NON_TEXT_RE = /(embedding|embed|tts|image|audio|video|lyria|imagen|computer-use|ocr)/;
const FREE_RE = /-free$/;

/**
 * How much a model family is trusted, per provider. Model ids are the only
 * signal available and their version numbers are not comparable across
 * families (glm-5.3 is not "newer" than gemini-3.8), so families are ranked
 * first and the version only orders models inside one family.
 */
const FAMILY_TRUST = {
  gemini: 95, claude: 90, gpt: 88, grok: 80, qwen: 78, glm: 76,
  minimax: 74, deepseek: 72, kimi: 70, nemotron: 60, muse: 55,
  mimo: 50, ling: 45, longcat: 40,
};
const UNKNOWN_FAMILY = 30;

const familyOf = (id) => String(id).toLowerCase().match(/^[a-z]+/)?.[0] || '';

/** `gemini-3.8-flash` -> 3.8, `claude-opus-4-8` -> 4.8, `big-pickle` -> 0. */
function versionOf(id) {
  const match = String(id).match(/(\d+(?:\.\d+)?)(?:-(\d+))?/);
  if (!match) return 0;
  return match[2] && !match[1].includes('.')
    ? Number.parseFloat(`${match[1]}.${match[2]}`)
    : Number.parseFloat(match[1]);
}

/**
 * Score one model id for one tier. Higher is better; `null` disqualifies it.
 * @param {string} id
 * @param {'fast'|'deep'} tier
 * @param {boolean} freeMatters  true for Zen, where free models cost nothing
 *   and are the least likely to be throttled — the backup provider leans on them
 */
export function scoreModel(id, tier, freeMatters = false) {
  const name = String(id).toLowerCase();
  if (NON_TEXT_RE.test(name)) return null;

  const family = familyOf(name);
  const fast = FAST_RE.test(name);
  const deep = DEEP_RE.test(name);

  let score = (FAMILY_TRUST[family] ?? UNKNOWN_FAMILY) + versionOf(name);

  if (tier === 'fast') {
    score += fast ? 100 : deep ? 10 : 40;
    if (freeMatters && FREE_RE.test(name)) score += 60;
  } else {
    score += deep ? 100 : fast ? 20 : 40;
  }
  return score;
}

/** Rank a catalogue into a de-duplicated chain for one tier. */
function rankChain(ids, tier, freeMatters) {
  const best = new Map();
  for (const id of ids) {
    const score = scoreModel(id, tier, freeMatters);
    if (score === null) continue;
    if (!best.has(id) || score > best.get(id)) best.set(id, score);
  }
  return [...best.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([id]) => id);
}

/**
 * Ranked chain with the scores kept, for the model browser in the control room.
 * Model lists run to ~80 entries on Zen, so the UI needs to explain its order.
 * @returns {{model: string, score: number}[]}
 */
function scoredChain(provider, tier) {
  const freeMatters = provider === 'zen';
  const best = new Map();
  for (const id of catalogueFor(provider)) {
    const score = scoreModel(id, tier, freeMatters);
    if (score === null) continue;
    if (!best.has(id) || score > best.get(id)) best.set(id, score);
  }
  return [...best.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([model, score]) => ({ model, score }));
}

/* ------------------------------------------------------------------ *
 * Discovery — "what does this key actually give me?"
 *
 * A hardcoded chain goes stale the moment OpenCode ships a model. So ask:
 *   gemini  -> models.list(), filtered to models that support generateContent
 *   zen     -> the public catalogue, filtered to ids we can transport
 *
 * The seeds below are only a fallback for the window before discovery lands
 * (or when a catalogue endpoint is unreachable) — they are deliberately short
 * and get replaced as soon as the real answer arrives.
 * ------------------------------------------------------------------ */

const SEED_CATALOGUE = {
  gemini: ['gemini-3.8-flash', 'gemini-3.7-flash', 'gemini-3.6-flash', 'gemini-3.5-flash',
    'gemini-2.5-flash', 'gemini-3.1-pro', 'gemini-2.5-pro'],
  zen: ['gemini-3.8-flash', 'gemini-3.7-flash', 'gemini-3.6-flash', 'gemini-3.5-flash',
    'gemini-3.1-pro', 'gemini-3-flash', 'deepseek-v4-flash', 'deepseek-v4-flash-free',
    'space-bunny-free', 'glm-5.3-flash', 'kimi-k3', 'minimax-m3'],
};

const discovery = {
  at: 0,
  inflight: null,
  providers: {
    gemini: { ok: false, error: null, models: [] },
    zen: { ok: false, error: null, models: [] },
  },
};

/** Google-native list, narrowed to models that can actually generate content. */
async function fetchGeminiCatalogue({ timeoutMs = 8000 } = {}) {
  const client = getGenaiClient(geminiKey());
  const pager = await client.models.list(
    { config: { pageSize: 200 } },
    { timeout: timeoutMs, maxRetries: 0 },
  );
  const ids = [];
  for await (const model of pager) {
    const name = String(model?.name || '').replace(/^models\//, '');
    if (!name) continue;
    const methods = model.supportedGenerationMethods || model.supportedActions || [];
    if (methods.length && !methods.includes('generateContent')) continue;
    ids.push(name);
  }
  return [...new Set(ids)];
}

/** Zen's catalogue is public; the key only narrows it (workspace allowlists). */
async function fetchZenCatalogue({ timeoutMs = 8000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const headers = {};
    const key = zenKey();
    if (key) headers.authorization = `Bearer ${key}`;
    const res = await fetch(ZEN_MODELS_URL, { headers, signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const arr = Array.isArray(data) ? data : (data.data || data.models || []);
    return [...new Set(arr.map((m) => m?.id || m?.model).filter(Boolean))]
      .filter(isSafeZenModel);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Ask every configured provider what it serves, and rank the answers.
 * Safe to call repeatedly: results are cached for AI_DISCOVERY_TTL_MS and
 * concurrent callers share one in-flight request.
 * @returns {Promise<{at:number, providers:object}>}
 */
export function discoverModels({ force = false, timeoutMs = 8000 } = {}) {
  const stale = Date.now() - discovery.at > DISCOVERY_TTL_MS;
  if (!force && !stale && discovery.at) return Promise.resolve(discovery);
  if (discovery.inflight) return discovery.inflight;

  discovery.inflight = (async () => {
    for (const provider of activeProviders()) {
      try {
        const models = provider === 'gemini'
          ? await fetchGeminiCatalogue({ timeoutMs })
          : await fetchZenCatalogue({ timeoutMs });
        discovery.providers[provider] = { ok: true, error: null, models };
      } catch (err) {
        discovery.providers[provider] = {
          ok: false,
          error: String(err?.message || err).slice(0, 200),
          models: [],
        };
      }
    }
    discovery.at = Date.now();
    discovery.inflight = null;
    return discovery;
  })();

  return discovery.inflight;
}

/**
 * Kick discovery off without blocking boot. Nothing awaits this: requests made
 * while it is in flight fall back to the seed chains, and `runStructured`
 * refreshes it in the background so the next request sees the real catalogue.
 */
function warmDiscovery() {
  if (!activeProviders().length) return;
  const timer = setTimeout(() => { discoverModels().catch(() => {}); }, 0);
  timer.unref?.();
}

/* ------------------------------------------------------------------ *
 * Chains
 * ------------------------------------------------------------------ */

/** The catalogue in use for a provider: discovered if known, seeded otherwise. */
function catalogueFor(provider) {
  const found = discovery.providers[provider]?.models;
  return found?.length ? found : SEED_CATALOGUE[provider];
}

/** Discovered (or seeded) chain for one provider + tier. */
export function candidateModels(provider, tier) {
  const ids = catalogueFor(provider);
  const chain = rankChain(ids, tier, provider === 'zen');
  return filterCandidates(provider, chain);
}

const preferred = new Map();    // `${tier}` -> `${provider}:${model}` that last worked
const deadModels = new Set();  // `${provider}:${model}`
const cooldowns = new Map();   // provider -> { until, reason }

function filterCandidates(provider, chain) {
  const until = cooldowns.get(provider)?.until ?? 0;
  if (until > Date.now()) return [];
  return chain.filter((m) => !deadModels.has(`${provider}:${m}`));
}

function coolDown(provider, ms, reason) {
  cooldowns.set(provider, { until: Date.now() + ms, reason });
}

const coolingDown = (provider) => (cooldowns.get(provider)?.until ?? 0) > Date.now();

/** Remove a provider from cooldown early (a success proves it is healthy). */
function clearCooldown(provider) {
  cooldowns.delete(provider);
}

/* ------------------------------------------------------------------ *
 * Provider plumbing
 * ------------------------------------------------------------------ */

const genaiClients = new Map();

function getGenaiClient(key) {
  if (!genaiClients.has('client')) {
    genaiClients.set('client', new GoogleGenAI({
      apiKey: key,
      ...(GEMINI_BASE_URL ? { httpOptions: { baseUrl: GEMINI_BASE_URL } } : {}),
    }));
  }
  return genaiClients.get('client');
}

class ProviderError extends Error {
  constructor(message, { unsupported = false, rateLimited = false, auth = false, retryAfterMs = null } = {}) {
    super(message);
    this.name = 'ProviderError';
    this.unsupported = unsupported;
    this.rateLimited = rateLimited;
    this.auth = auth;
    this.retryAfterMs = retryAfterMs;
  }
}

function withTimeout(externalSignal, ms = REQUEST_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  const onAbort = () => controller.abort();
  externalSignal?.addEventListener('abort', onAbort, { once: true });
  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timer);
      externalSignal?.removeEventListener('abort', onAbort);
    },
  };
}

/** Bucket an upstream failure so the router knows what to do about it. */
function classify(res, text) {
  const retryAfter = Number.parseInt(res.headers?.get?.('retry-after') || '', 10);
  return new ProviderError(`HTTP ${res.status}: ${String(text).slice(0, 300)}`, {
    unsupported: res.status === 404
      || /not\s*(found|supported|available|enabled)|does not exist|unknown model|unsupported|invalid model|disabled model/i
        .test(text),
    rateLimited: res.status === 429
      || /rate.?limit|too many requests|resource.?exhausted|quota|overloaded|capacity/i
        .test(text),
    auth: res.status === 401 || res.status === 403
      || /api key not valid|invalid api key|permission denied|unauthorized/i.test(text),
    retryAfterMs: Number.isFinite(retryAfter) ? retryAfter * 1000 : null,
  });
}

const UNSUPPORTED_RE = /not\s*(found|supported|available|enabled)|does not exist|unknown model|unsupported|invalid model|disabled model/i;
const RATE_LIMITED_RE = /rate.?limit|too many requests|resource.?exhausted|quota|overloaded|capacity|429/i;
const AUTH_RE = /api key not valid|invalid api key|permission denied|unauthorized|\b40[13]\b/;

/**
 * Same three questions, asked of any error — including the SDK's own
 * ApiError, which reports the HTTP status on `.status` rather than as a
 * ProviderError. Without this a throttled Gemini key looks like any other
 * failure and never gets parked.
 */
function bucketError(err) {
  if (err instanceof ProviderError) {
    return {
      unsupported: err.unsupported,
      rateLimited: err.rateLimited,
      auth: err.auth,
      retryAfterMs: err.retryAfterMs,
    };
  }
  const status = Number(err?.status) || Number(err?.code) || 0;
  const text = String(err?.message || err);
  return {
    unsupported: status === 404 || UNSUPPORTED_RE.test(text),
    rateLimited: status === 429 || RATE_LIMITED_RE.test(text),
    auth: status === 401 || status === 403 || AUTH_RE.test(text),
    retryAfterMs: null,
  };
}

function isEmptyCompletion() {
  return new ProviderError('empty completion');
}

/* ------------------ Zen: Google-native route (gemini-*) ------------------ */

/**
 * Zen serves its Gemini models on the Google-native route, but the
 * @google/genai SDK cannot target it: it rewrites the model to
 * `v1beta/models/<id>` and authenticates with `x-goog-api-key`, whereas Zen
 * documents `/zen/v1/models/<id>` with a bearer token. So this call is
 * hand-rolled to keep the URL and headers exactly as Zen expects.
 */
async function callZenGoogle({ model, system, prompt, schema, maxTokens, signal }) {
  const apiKey = zenKey();
  if (!apiKey) throw new ProviderError('No OpenCode Zen API key configured');

  const { signal: composed, cleanup } = withTimeout(signal);

  try {
    const res = await fetch(`${ZEN_GOOGLE_BASE}/${encodeURIComponent(model)}:generateContent`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${apiKey}`,
        // Also sent for gateways that follow Google's own header convention.
        'x-goog-api-key': apiKey,
        accept: 'application/json',
      },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0.2,
          maxOutputTokens: maxTokens,
          // Enforced structured JSON.
          responseMimeType: 'application/json',
          ...(schema ? { responseSchema: schema } : {}),
        },
      }),
      signal: composed,
    });

    if (!res.ok) throw classify(res, await res.text().catch(() => ''));

    const data = await res.json();

    if (data?.promptFeedback?.blockReason) {
      throw new ProviderError(`Blocked by safety filter: ${data.promptFeedback.blockReason}`);
    }

    const text = (data?.candidates?.[0]?.content?.parts || [])
      .map((p) => p?.text || '')
      .join('')
      .trim();

    if (!text) throw isEmptyCompletion();
    return text;
  } finally {
    cleanup();
  }
}

/* ------------------ Zen: OpenAI-compatible route ------------------ */

async function callZenOpenAI({ model, system, prompt, maxTokens, signal }) {
  const apiKey = zenKey();
  if (!apiKey) throw new ProviderError('No OpenCode Zen API key configured');

  const { signal: composed, cleanup } = withTimeout(signal);

  try {
    const res = await fetch(ZEN_CHAT_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${apiKey}`,
        accept: 'application/json',
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: prompt },
        ],
        temperature: 0.2,
        max_tokens: maxTokens,
        response_format: { type: 'json_object' },
      }),
      signal: composed,
    });

    if (!res.ok) throw classify(res, await res.text().catch(() => ''));

    const data = await res.json();
    const content = data?.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || content.trim() === '') throw isEmptyCompletion();
    return content;
  } finally {
    cleanup();
  }
}

/* ------------------ Zen: Anthropic /messages route (claude-*) -------------- */

async function callZenAnthropic({ model, system, prompt, maxTokens, signal }) {
  const apiKey = zenKey();
  if (!apiKey) throw new ProviderError('No OpenCode Zen API key configured');

  const { signal: composed, cleanup } = withTimeout(signal);

  try {
    const res = await fetch(ZEN_MESSAGES_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${apiKey}`,
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        accept: 'application/json',
      },
      body: JSON.stringify({
        model,
        max_tokens: maxTokens,
        temperature: 0.2,
        system,
        messages: [{ role: 'user', content: prompt }],
      }),
      signal: composed,
    });

    if (!res.ok) throw classify(res, await res.text().catch(() => ''));

    const data = await res.json();
    const text = (data?.content || [])
      .filter((block) => block?.type === 'text' || typeof block?.text === 'string')
      .map((block) => block.text || '')
      .join('')
      .trim();

    if (!text) throw isEmptyCompletion();
    return text;
  } finally {
    cleanup();
  }
}

/* ------------------ Zen: OpenAI /responses route (gpt-*, grok-*) ---------- */

async function callZenResponses({ model, system, prompt, maxTokens, signal }) {
  const apiKey = zenKey();
  if (!apiKey) throw new ProviderError('No OpenCode Zen API key configured');

  const { signal: composed, cleanup } = withTimeout(signal);

  try {
    const res = await fetch(ZEN_RESPONSES_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${apiKey}`,
        accept: 'application/json',
      },
      body: JSON.stringify({
        model,
        max_output_tokens: maxTokens,
        temperature: 0.2,
        input: [
          { role: 'system', content: [{ type: 'input_text', text: system }] },
          { role: 'user', content: [{ type: 'input_text', text: prompt }] },
        ],
      }),
      signal: composed,
    });

    if (!res.ok) throw classify(res, await res.text().catch(() => ''));

    const data = await res.json();
    const text = (typeof data?.output_text === 'string' && data.output_text)
      || (data?.output || [])
        .flatMap((item) => item?.content || [])
        .map((part) => part?.text || '')
        .join('')
      || data?.choices?.[0]?.message?.content;

    if (typeof text !== 'string' || !text.trim()) throw isEmptyCompletion();
    return text.trim();
  } finally {
    cleanup();
  }
}

/* ------------------ Gemini direct (GEMINI_API_KEY) ------------------ */

/** Google's own generateContent endpoint via the official SDK. */
async function callGeminiDirect({ model, system, prompt, schema, maxTokens, signal }) {
  const apiKey = geminiKey();
  if (!apiKey) throw new ProviderError('GEMINI_API_KEY is not set');

  const client = getGenaiClient(apiKey);
  const { signal: composed, cleanup } = withTimeout(signal);

  try {
    const res = await client.models.generateContent({
      model,
      contents: [{ text: prompt }],
      config: {
        systemInstruction: system,
        temperature: 0.2,
        maxOutputTokens: maxTokens,
        // Enforced structured JSON.
        responseMimeType: 'application/json',
        ...(schema ? { responseSchema: schema } : {}),
        abortSignal: composed,
      },
    });
    const text = res?.text;
    if (typeof text !== 'string' || text.trim() === '') throw isEmptyCompletion();
    return text;
  } finally {
    cleanup();
  }
}

/* ------------------------------------------------------------------ *
 * Dispatch
 * ------------------------------------------------------------------ */

async function callProvider({ provider, model, system, prompt, schema, maxTokens, signal }) {
  if (provider === 'gemini') {
    try {
      return await callGeminiDirect({ model, system, prompt, schema, maxTokens, signal });
    } catch (err) {
      // Some served models reject responseSchema; retry with the portable
      // responseMimeType-only form before giving up on the model.
      if (schema && /response.?schema|schema.*(not|invalid|unsupported)|unknown field/i
        .test(String(err?.message || ''))) {
        return callGeminiDirect({ model, system, prompt, schema: null, maxTokens, signal });
      }
      throw err;
    }
  }

  if (zenRouteFor(model) === 'openai') {
    return callZenOpenAI({ model, system, prompt, maxTokens, signal });
  }

  const call = zenRouteFor(model) === 'anthropic'
    ? callZenAnthropic
    : zenRouteFor(model) === 'responses'
      ? callZenResponses
      : callZenGoogle;

  if (zenRouteFor(model) !== 'google') {
    return call({ model, system, prompt, maxTokens, signal });
  }

  try {
    return await call({ model, system, prompt, schema, maxTokens, signal });
  } catch (err) {
    if (schema && /response.?schema|schema.*(not|invalid|unsupported)|unknown field/i
      .test(String(err?.message || ''))) {
      return call({ model, system, prompt, schema: null, maxTokens, signal });
    }
    throw err;
  }
}

/* ------------------------------------------------------------------ *
 * JSON extraction — models are helpful, not obedient.
 * ------------------------------------------------------------------ */

/**
 * Pull a JSON value out of arbitrary model output.
 * Handles bare JSON, ```json fences, and JSON surrounded by prose.
 */
export function extractJson(text) {
  if (typeof text !== 'string') return null;
  const trimmed = text.trim();
  if (!trimmed) return null;

  const tryParse = (s) => {
    try {
      return JSON.parse(s);
    } catch {
      return null;
    }
  };

  const direct = tryParse(trimmed);
  if (direct) return direct;

  // Fenced block
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) {
    const parsed = tryParse(fence[1].trim());
    if (parsed) return parsed;
  }

  // Balanced scan for the first object/array, respecting strings and escapes.
  const start = trimmed.search(/[{[]/);
  if (start === -1) return null;
  const open = trimmed[start];
  const close = open === '{' ? '}' : ']';

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < trimmed.length; i += 1) {
    const ch = trimmed[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === open) depth += 1;
    else if (ch === close) {
      depth -= 1;
      if (depth === 0) return tryParse(trimmed.slice(start, i + 1));
    }
  }

  return null;
}

/* ------------------------------------------------------------------ *
 * Core runner
 * ------------------------------------------------------------------ */

const cache = new Map();
const CACHE_TTL_MS = Number.parseInt(process.env.AI_CACHE_TTL_MS || '300000', 10);

const cacheKey = (tier, task, payload) => `${tier}|${task}|${JSON.stringify(payload)}`;

/**
 * A hand-written chain, if one was set. The escape hatch for the cases
 * discovery cannot guess: a model you trust more than the ranking, or one you
 * want to pin across providers. Entries are `provider:model`, or a bare model
 * id to route to the primary provider that serves it.
 */
function overridePlan(notes) {
  const raw = process.env.AI_MODEL_CHAIN;
  if (!raw) return null;
  const providers = activeProviders();
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((entry) => {
      const split = entry.indexOf(':');
      const [provider, model] = split > 0
        ? [entry.slice(0, split), entry.slice(split + 1)]
        : [providers.find((p) => catalogueFor(p).includes(entry)) || providers[0], entry];
      if (!model) return null;
      if (!keyFor(provider)) notes.push(`AI_MODEL_CHAIN: no API key for "${provider}" (${model})`);
      return { provider, model };
    })
    .filter(Boolean);
}

/**
 * The ordered attempt list for one tier: Gemini first, Zen behind it, so a
 * throttled or mis-scoped Gemini key falls through to the backup instead of
 * failing the request.
 * @param {string[]} notes filled with anything it had to drop
 */
function buildPlan(tier, notes = []) {
  const override = overridePlan(notes);
  const plan = [];
  const seen = new Set();
  const add = (provider, models) => {
    if (!keyFor(provider)) {
      notes.push(`no API key for provider "${provider}"`);
      return;
    }
    if (coolingDown(provider)) {
      notes.push(`${provider} is cooling down after a rate limit`);
      return;
    }
    for (const model of models) {
      const key = `${provider}:${model}`;
      if (seen.has(key) || deadModels.has(key)) continue;
      seen.add(key);
      plan.push({ provider, model });
    }
  };

  const pinned = preferred.get(tier);
  if (pinned) add(pinned.split(':')[0], [pinned.split(':').slice(1).join(':')]);

  if (override) {
    for (const { provider, model } of override) add(provider, [model]);
    return plan;
  }

  for (const provider of activeProviders()) {
    add(provider, candidateModels(provider, tier));
  }
  return plan;
}

/**
 * Run a structured analysis.
 * @param {object} opts
 * @param {string} opts.task      short key, used for cache + routing
 * @param {string} opts.system    system instruction
 * @param {string} opts.prompt    user prompt (payload is JSON, already embedded)
 * @param {object} [opts.schema]  Google-native responseSchema
 * @param {'fast'|'deep'} [opts.tier]
 * @param {number} [opts.maxTokens]
 * @param {Function} [opts.fallback]  () => object, used when AI is unavailable
 * @param {AbortSignal} [opts.signal]
 * @returns {Promise<{data:object, source:string, model:string|null, provider:string,
 *                    latencyMs:number, degraded:boolean, error?:string}>}
 */
export async function runStructured({
  task,
  system,
  prompt,
  schema = null,
  tier = DEFAULT_TIER,
  maxTokens = 2048,
  fallback = null,
  signal = undefined,
}) {
  const startedAt = Date.now();

  if (!activeProviders().length) {
    return {
      data: fallback ? fallback() : {},
      source: 'offline',
      provider: 'offline',
      model: null,
      latencyMs: Date.now() - startedAt,
      degraded: true,
      error: 'No GEMINI_API_KEY or OPENCODE_ZEN_API_KEY configured — served deterministic local analysis.',
    };
  }

  // Refresh the catalogue in the background; the seed chains above keep the
  // very first request working while that is in flight.
  discoverModels().catch(() => {});

  const key = cacheKey(tier, task, { prompt, system });
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) {
    return { ...hit.value, cached: true };
  }

  const errors = [];
  const notes = [];

  for (const { provider, model } of buildPlan(tier, notes)) {
    if (signal?.aborted) break;
    try {
      const raw = await callProvider({
        provider, model, system, prompt, schema, maxTokens, signal,
      });
      const parsed = extractJson(raw);

      if (!parsed || typeof parsed !== 'object') {
        errors.push(`${provider}/${model}: response was not valid JSON`);
        continue;
      }

      preferred.set(tier, `${provider}:${model}`);
      clearCooldown(provider);

      const value = {
        data: parsed,
        source: provider,
        provider,
        model,
        latencyMs: Date.now() - startedAt,
        degraded: false,
      };
      cache.set(key, { at: Date.now(), value });
      return value;
    } catch (err) {
      const message = String(err?.message || err);
      const bucket = bucketError(err);
      if (bucket.unsupported) deadModels.add(`${provider}:${model}`);
      if (bucket.rateLimited) {
        coolDown(provider, bucket.retryAfterMs || RATE_LIMIT_COOLDOWN_MS, message.slice(0, 120));
      }
      if (bucket.auth) {
        coolDown(provider, BAD_KEY_COOLDOWN_MS, message.slice(0, 120));
        deadModels.add(`${provider}:${model}`);
      }
      errors.push(`${provider}/${model}: ${message.slice(0, 160)}`);
    }
  }

  return {
    data: fallback ? fallback() : {},
    source: 'fallback',
    provider: activeProviders()[0] || 'offline',
    model: null,
    latencyMs: Date.now() - startedAt,
    degraded: true,
    error: [...notes, ...errors].join(' | ') || 'AI provider unavailable',
  };
}

/* ------------------------------------------------------------------ *
 * Introspection
 * ------------------------------------------------------------------ */

/**
 * The catalogues as last read, with no network call. Cheap enough for the
 * health endpoint, which the browser hits on every page load.
 */
export function catalogueSnapshot() {
  const out = {};
  for (const provider of configuredProviders()) {
    const found = discovery.providers[provider];
    out[provider] = {
      ok: Boolean(found?.ok),
      error: found?.error || null,
      stale: !discovery.at,
      count: catalogueFor(provider).length,
      models: catalogueFor(provider),
    };
  }
  return out;
}

/** One tiny real request, to prove a model id works with the key. */
async function probeModel({ provider, model, timeoutMs = 20000 }) {
  const startedAt = Date.now();
  try {
    const raw = await callProvider({
      provider,
      model,
      system: 'Reply with JSON only.',
      prompt: 'Return exactly this JSON object: {"ok":true}',
      maxTokens: 64,
    });
    const ok = Boolean(extractJson(raw));
    return {
      provider,
      model,
      route: provider === 'zen' ? zenRouteFor(model) : 'gemini',
      ok,
      latencyMs: Date.now() - startedAt,
      ...(ok ? {} : { error: 'responded, but not with JSON' }),
    };
  } catch (err) {
    return {
      provider,
      model,
      route: provider === 'zen' ? zenRouteFor(model) : 'gemini',
      ok: false,
      latencyMs: Date.now() - startedAt,
      error: String(err?.message || err).slice(0, 200),
    };
  }
}

/**
 * "What does this key give me?" — asked and answered.
 *
 * Refreshes the catalogues, then actually calls the top of each chain so the
 * answer is verified rather than assumed. Exposed at POST /api/ai/probe and
 * by `npm run ai:probe`.
 *
 * @param {{tier?:'fast'|'deep', verify?:boolean, limit?:number}} [opts]
 */
export async function probeKeys({ tier = DEFAULT_TIER, verify = true, limit = 6, provider = null } = {}) {
  await discoverModels({ force: true });

  const keys = {};
  // Probe every configured key, not just the ones routing would use: a key that
  // is switched off today may be switched on tomorrow, and the operator needs
  // to know whether it works before they flip it. `provider` narrows that to a
  // single card, so pressing one card's button costs one key's worth of calls.
  for (const providerId of configuredProviders()) {
    if (provider && providerId !== provider) continue;
    const models = candidateModels(providerId, tier);
    const head = models.slice(0, limit);
    keys[providerId] = {
      configured: true,
      active: activeProviders().includes(providerId),
      key: maskKey(keyFor(providerId)),
      catalogue: {
        ok: discovery.providers[providerId].ok,
        error: discovery.providers[providerId].error,
        count: catalogueFor(providerId).length,
      },
      tier,
      chain: models,
      probes: verify ? await Promise.all(head.map((model) => probeModel({ provider: providerId, model }))) : [],
    };
  }

  // One flat, ordered list of everything actually tried. The control room
  // renders this directly, so it must carry the verdict per model rather than
  // making the browser dig through the keyed structure to find it.
  const probes = Object.values(keys).flatMap((k) => k.probes)
    .sort((a, b) => Number(b.ok) - Number(a.ok) || a.latencyMs - b.latencyMs);

  return {
    ok: true,
    at: new Date().toISOString(),
    order: providerOrder(),
    primary: activeProviders()[0] || 'offline',
    probed: Object.keys(keys),
    probes,
    keys,
  };
}

function maskKey(key) {
  if (!key) return null;
  return `${'*'.repeat(Math.min(12, Math.max(0, key.length - 4)))}${key.slice(-4)}`;
}

const ZEN_TRANSPORTS = () => ({
  google: ZEN_GOOGLE_BASE,
  anthropic: ZEN_MESSAGES_URL,
  responses: ZEN_RESPONSES_URL,
  openai: ZEN_CHAT_URL,
});

const PROVIDER_LABELS = { gemini: 'Google Gemini', zen: 'OpenCode Zen' };

/** The two providers this build knows how to talk to. Single source of truth. */
export const PROVIDERS = Object.keys(PROVIDER_LABELS);

/**
 * Everything the control room needs to show about the two providers: the key,
 * where it points, what it actually serves, how it is ranked, and why it might
 * be skipped right now.
 *
 * Deliberately reports *every* configured provider, not just the ones the
 * current order would route to — a key that is present but switched off is
 * information an operator needs, not noise to hide.
 */
export function providerReport() {
  const order = providerOrder();
  const active = activeProviders();
  const notes = [];

  if (!configuredProviders().length) {
    notes.push('No provider key configured — every analysis runs the deterministic '
      + 'offline path.');
  } else {
    for (const p of configuredProviders()) {
      if (active.includes(p)) continue;
      notes.push(order.endsWith('-only')
        ? `"${p}" is configured but AI_PROVIDER_ORDER excludes it.`
        : `"${p}" is configured but has no key, so it cannot be used.`);
    }
  }

  const providers = configuredProviders().map((p) => {
    const found = discovery.providers[p];
    const chain = (tier) => scoredChain(p, tier).map(({ model }) => model);
    const cooldown = cooldowns.get(p);

    return {
      id: p,
      label: PROVIDER_LABELS[p] || p,
      configured: true,
      active: active.includes(p),
      key: maskKey(keyFor(p)),
      endpoint: p === 'zen' ? ZEN_BASE : (GEMINI_BASE_URL || 'generativelanguage.googleapis.com'),
      transports: p === 'zen' ? ZEN_TRANSPORTS() : null,
      catalogue: {
        ok: Boolean(found?.ok),
        error: found?.error || null,
        count: catalogueFor(p).length,
        discoveredAt: discovery.at ? new Date(discovery.at).toISOString() : null,
        discovered: Boolean(found?.models?.length),
      },
      chains: { fast: chain('fast'), deep: chain('deep') },
      cooldown: cooldown && cooldown.until > Date.now()
        ? { until: new Date(cooldown.until).toISOString(), reason: cooldown.reason }
        : null,
      deadModels: [...deadModels]
        .filter((k) => k.startsWith(`${p}:`))
        .map((k) => k.slice(p.length + 1)),
    };
  });

  // The full browsable catalogue, ranked per tier, for the model picker.
  const models = configuredProviders().flatMap((p) => {
    const fast = new Map(scoredChain(p, 'fast').map((e) => [e.model, e.score]));
    const deep = new Map(scoredChain(p, 'deep').map((e) => [e.model, e.score]));
    return [...new Set([...fast.keys(), ...deep.keys()])].map((model) => ({
      provider: p,
      model,
      fast: fast.get(model) ?? null,
      deep: deep.get(model) ?? null,
      free: FREE_RE.test(model),
      ...(p === 'zen' ? { route: zenRouteFor(model) } : { route: 'gemini' }),
      dead: deadModels.has(`${p}:${model}`),
    }));
  }).sort((a, b) => (b.fast ?? 0) - (a.fast ?? 0) || (b.deep ?? 0) - (a.deep ?? 0));

  const pinned = String(process.env.AI_MODEL_CHAIN || '')
    .split(',').map((s) => s.trim()).filter(Boolean);

  return {
    ok: true,
    at: new Date().toISOString(),
    order,
    primary: active[0] || 'offline',
    providers,
    models,
    pinned,
    notes,
    tier: DEFAULT_TIER,
    plan: {
      fast: buildPlan('fast').map((c) => `${c.provider}:${c.model}`),
      deep: buildPlan('deep').map((c) => `${c.provider}:${c.model}`),
    },
    timeoutMs: REQUEST_TIMEOUT_MS,
    cacheTtlMs: CACHE_TTL_MS,
  };
}

export function aiStatus() {
  const providers = activeProviders();
  const primary = providers[0] || 'offline';
  const chain = (t) => providers.flatMap((p) => candidateModels(p, t).map((m) => ({
    provider: p,
    model: m,
    ...(p === 'zen' ? { route: zenRouteFor(m) } : {}),
  })));

  return {
    provider: primary,
    providers,
    order: providerOrder(),
    // Every key we hold, including any the current order has switched off.
    configuredProviders: configuredProviders(),
    configured: providers.length > 0,
    tier: DEFAULT_TIER,
    endpoint: primary === 'zen'
      ? ZEN_BASE
      : primary === 'gemini' ? (GEMINI_BASE_URL || 'generativelanguage.googleapis.com') : null,
    transports: configuredProviders().includes('zen') ? ZEN_TRANSPORTS() : null,
    models: primary === 'offline' ? null : chain(DEFAULT_TIER).map((c) => c.model),
    deepModels: primary === 'offline' ? null : chain('deep').map((c) => c.model),
    plan: primary === 'offline' ? null : { fast: chain('fast'), deep: chain('deep') },
    discovery: {
      at: discovery.at ? new Date(discovery.at).toISOString() : null,
      providers: Object.fromEntries(configuredProviders().map((p) => [p, {
        ok: discovery.providers[p].ok,
        error: discovery.providers[p].error,
        models: catalogueFor(p).length,
        cooldown: cooldowns.get(p)?.until > Date.now() ? cooldowns.get(p) : null,
      }])),
    },
    timeoutMs: REQUEST_TIMEOUT_MS,
  };
}

warmDiscovery();

export {
  ZEN_BASE,
  ZEN_CHAT_URL,
  ZEN_GOOGLE_BASE,
  ZEN_MESSAGES_URL,
  ZEN_RESPONSES_URL,
  ZEN_MODELS_URL,
  DEFAULT_TIER,
  SEED_CATALOGUE as seedCatalogue,
};
