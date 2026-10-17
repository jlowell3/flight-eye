import { enforceRateLimit, openAiRateLimiter } from './rate-limit.js';
import {
  resolveVoiceModel,
  isKnownVoiceTier,
} from '../../../src/voice/voiceCost.js';
import {
  OPENAI_REALTIME_MODEL_MINI_DEFAULT,
  OPENAI_REALTIME_MODEL_DEFAULT,
  OPENAI_REALTIME_VOICE_DEFAULT,
  OPENAI_REALTIME_REASONING_DEFAULT,
  OPENAI_REALTIME_CONTEXT_TOKENS_DEFAULT,
  OPENAI_REALTIME_CONTEXT_RETENTION_DEFAULT,
  OPENAI_REALTIME_TRANSCRIBE_MODEL_DEFAULT,
} from './constants.js';
import { realtimeInstructions } from './instructions.js';
import { GEV_REALTIME_TOOLS } from './tools.js';
import { isVoiceProfile, toolsForVoiceProfile } from './profiles.js';
import {
  isVoicePersona,
  personaVoice,
  resolveVoicePersona,
} from '../../../src/voice/personas.js';
import {
  preferCodexOAuth,
  readCodexOAuthAccessToken,
  createCodexOAuthLogin,
} from './codex-auth.js';
// Flight Eye hosting: the daily mint cap and the proxy-aware client address.
import {
  dailyMintBudget,
  enforceDailyMintCap,
  mintBucket,
} from './mint-budget.js';
import { clientAddress } from '../common/trusted-proxy.js';

const LOOPBACK_ADDRESSES = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

function isLoopbackRequest(req) {
  // Behind a trusted proxy (GEV_TRUSTED_PROXY) the socket is always loopback;
  // the forwarded address decides, so a phone cannot reach the OAuth paths.
  return LOOPBACK_ADDRESSES.has(String(clientAddress(req) || ''));
}

function isSameOriginRequest(req) {
  const origin = String(req.headers?.origin || '').trim();
  if (!origin) return true;
  const host = String(req.headers?.host || '').trim();
  if (!host) return false;
  const protocol = req.socket?.encrypted ? 'https:' : 'http:';
  try {
    return new URL(origin).origin === new URL(`${protocol}//${host}`).origin;
  } catch {
    return false;
  }
}

function requestQuery(req) {
  try {
    return new URL(req.url || '', 'http://localhost').searchParams;
  } catch {
    return new URLSearchParams();
  }
}

function resolveRealtimeAuthMode(query) {
  const requested = String(query.get('auth') || 'api-key').toLowerCase();
  if (requested === 'api-key' || requested === 'oauth') return requested;
  return null;
}

function createRealtimeOAuthStatusHandler({
  oauthLogin = createCodexOAuthLogin(),
} = {}) {
  return (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Type', 'application/json');
    if (req.method !== 'GET') {
      res.statusCode = 405;
      res.end(JSON.stringify({ error: 'Method not allowed' }));
      return;
    }
    if (!isLoopbackRequest(req)) {
      res.statusCode = 403;
      res.end(
        JSON.stringify({
          available: false,
          error: 'ChatGPT OAuth is available only from this machine',
        }),
      );
      return;
    }
    res.statusCode = 200;
    res.end(JSON.stringify(oauthLogin.status()));
  };
}

function createRealtimeOAuthLoginHandler({
  oauthLogin = createCodexOAuthLogin(),
} = {}) {
  return async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Type', 'application/json');
    if (req.method !== 'POST') {
      res.statusCode = 405;
      res.end(JSON.stringify({ error: 'Method not allowed' }));
      return;
    }
    if (!isLoopbackRequest(req)) {
      res.statusCode = 403;
      res.end(
        JSON.stringify({
          available: false,
          error: 'ChatGPT OAuth sign-in is available only from this machine',
        }),
      );
      return;
    }
    if (!isSameOriginRequest(req)) {
      res.statusCode = 403;
      res.end(
        JSON.stringify({
          available: false,
          error: 'Cross-origin ChatGPT OAuth sign-in is not allowed',
        }),
      );
      return;
    }

    try {
      const result = await oauthLogin.start();
      res.statusCode = result.available ? 200 : result.loginFailed ? 503 : 202;
      res.end(JSON.stringify(result));
    } catch {
      res.statusCode = 503;
      res.end(
        JSON.stringify({
          available: false,
          error: 'Could not start ChatGPT sign-in',
        }),
      );
    }
  };
}

function createRealtimeTokenHandler({
  annotationGuidance,
  endpoint = 'https://api.openai.com/v1/realtime/client_secrets',
  fetchImpl = (...args) => fetch(...args),
  resolveApiKey = () => process.env.OPENAI_API_KEY,
  resolveOAuthAccessToken = () => readCodexOAuthAccessToken(),
  environment = process.env,
  models = {},
  tools = GEV_REALTIME_TOOLS,
  // Flight Eye: the daily mint budget; undefined reads GEV_VOICE_DAILY_MINTS
  // on first request, null turns the cap off, an object is used as given.
  mintBudget,
} = {}) {
  return async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    if (req.method !== 'GET' && req.method !== 'POST') {
      res.statusCode = 405;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ error: 'Method not allowed' }));
      return;
    }

    const query = requestQuery(req);
    const authMode = resolveRealtimeAuthMode(query);
    if (!authMode) {
      res.statusCode = 400;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ error: 'Unsupported cloud voice auth mode' }));
      return;
    }
    // Voice profile, requested by a trimmed build as ?profile=<name>. An
    // unknown name is refused rather than silently widened to every tool.
    const profile = query.get('profile') || null;
    if (!isVoiceProfile(profile)) {
      res.statusCode = 400;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ error: 'Unknown voice profile' }));
      return;
    }
    // Voice persona (Flight Eye's controller or co-pilot), requested as
    // ?persona=<name>; it prepends its lines to the instructions and picks
    // the voice. Unknown names are refused.
    const persona = query.get('persona') || null;
    if (!isVoicePersona(persona)) {
      res.statusCode = 400;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ error: 'Unknown voice persona' }));
      return;
    }
    let sessionTools;
    try {
      sessionTools = toolsForVoiceProfile(tools, profile);
    } catch (error) {
      res.statusCode = 500;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ error: error.message }));
      return;
    }

    let oauthPinned;
    try {
      oauthPinned = preferCodexOAuth(environment);
    } catch (error) {
      res.statusCode = 503;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ error: error.message }));
      return;
    }
    if (oauthPinned && authMode !== 'oauth') {
      res.statusCode = 503;
      res.setHeader('Content-Type', 'application/json');
      res.end(
        JSON.stringify({
          error:
            'ChatGPT OAuth is required by GEV_PREFER_CODEX_OAUTH. Select USE CHATGPT OAUTH in Provider Settings.',
          code: 'CODEX_OAUTH_REQUIRED',
        }),
      );
      return;
    }

    // Per-IP throttle (GEV_RATELIMIT_OPENAI_PER_MIN). On by default; 0 disables.
    if (!enforceRateLimit(openAiRateLimiter(), req, res)) return;
    // Flight Eye spend brake (GEV_VOICE_DAILY_MINTS): successful mints per UTC
    // day per app key or client address. Off unless set (mint-budget.js).
    const budget = mintBudget === undefined ? dailyMintBudget() : mintBudget;
    const bucket = budget ? mintBucket(req) : null;
    if (!enforceDailyMintCap(budget, bucket, res)) return;

    let bearer;
    if (authMode === 'oauth') {
      if (!isLoopbackRequest(req)) {
        res.statusCode = 403;
        res.setHeader('Content-Type', 'application/json');
        res.end(
          JSON.stringify({
            error: 'ChatGPT OAuth voice is available only from this machine',
          }),
        );
        return;
      }
      try {
        bearer = resolveOAuthAccessToken();
      } catch (error) {
        res.statusCode = 503;
        res.setHeader('Content-Type', 'application/json');
        res.end(
          JSON.stringify({
            error: error?.message || 'ChatGPT sign-in is unavailable',
            code: error?.code || 'CODEX_OAUTH_UNAVAILABLE',
          }),
        );
        return;
      }
      if (!bearer) {
        res.statusCode = 503;
        res.setHeader('Content-Type', 'application/json');
        res.end(
          JSON.stringify({
            error: 'ChatGPT sign-in is unavailable',
            code: 'CODEX_OAUTH_UNAVAILABLE',
          }),
        );
        return;
      }
    } else {
      bearer = resolveApiKey();
      if (!bearer) {
        res.statusCode = 503;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'OPENAI_API_KEY is not set' }));
        return;
      }
    }

    // Voice model tier, requested by the client as ?tier=standard|mini.
    // resolveVoiceModel is total: an unknown, empty, or hostile value
    // resolves to `standard` instead of reaching OpenAI as a model id, so a
    // bad querystring degrades to a normal session rather than a dead mic.
    // The env overrides stay authoritative per tier (see .env.example) —
    // a wrong upstream model id is then a config fix, not a code change.
    const requestedTier = query.get('tier');
    const tier = resolveVoiceModel(requestedTier).tier;
    const model =
      tier === 'mini'
        ? models.mini ||
          process.env.OPENAI_REALTIME_MODEL_MINI ||
          OPENAI_REALTIME_MODEL_MINI_DEFAULT
        : models.standard ||
          process.env.OPENAI_REALTIME_MODEL ||
          OPENAI_REALTIME_MODEL_DEFAULT;
    const voice =
      personaVoice(persona, process.env) ||
      process.env.OPENAI_REALTIME_VOICE ||
      OPENAI_REALTIME_VOICE_DEFAULT;
    const effort =
      process.env.OPENAI_REALTIME_REASONING_EFFORT ||
      OPENAI_REALTIME_REASONING_DEFAULT;
    const contextTokenLimit = Math.round(
      Math.max(
        1000,
        Math.min(
          12000,
          Number(process.env.OPENAI_REALTIME_CONTEXT_TOKENS) ||
            OPENAI_REALTIME_CONTEXT_TOKENS_DEFAULT,
        ),
      ),
    );
    const contextRetentionRatio = Math.max(
      0.1,
      Math.min(
        1,
        Number(process.env.OPENAI_REALTIME_CONTEXT_RETENTION) ||
          OPENAI_REALTIME_CONTEXT_RETENTION_DEFAULT,
      ),
    );
    // User captions for the voice card. Billed separately from the session.
    const transcribeModel =
      process.env.OPENAI_REALTIME_TRANSCRIBE_MODEL ||
      OPENAI_REALTIME_TRANSCRIBE_MODEL_DEFAULT;
    const transcription =
      transcribeModel.toLowerCase() === 'off'
        ? {}
        : { transcription: { model: transcribeModel } };
    const sessionConfig = {
      session: {
        type: 'realtime',
        model,
        reasoning: { effort },
        truncation: {
          type: 'retention_ratio',
          retention_ratio: contextRetentionRatio,
          token_limits: {
            post_instructions: contextTokenLimit,
          },
        },
        audio: {
          input: {
            noise_reduction: { type: 'near_field' },
            ...transcription,
            turn_detection: {
              type: 'semantic_vad',
              eagerness: 'low',
              create_response: true,
              interrupt_response: false,
            },
          },
          output: { voice },
        },
        instructions: realtimeInstructions(annotationGuidance, { persona }),
        tools: sessionTools,
        tool_choice: 'auto',
      },
    };

    try {
      const response = await fetchImpl(endpoint, {
        method: 'POST',
        redirect: 'error',
        signal: AbortSignal.timeout(30_000),
        headers: {
          Authorization: `Bearer ${bearer}`,
          'Content-Type': 'application/json',
          'OpenAI-Safety-Identifier': 'gev-local-dev',
        },
        body: JSON.stringify(sessionConfig),
      });
      const body = await response.text();
      res.statusCode = response.status;
      // Which tier/model this secret was actually minted for. The upstream
      // success body is passed through untouched (the client parses it
      // verbatim), so these headers are the authoritative echo — including the
      // case where a bogus ?tier= was silently downgraded to standard.
      res.setHeader('X-GEV-Voice-Tier', tier);
      res.setHeader('X-GEV-Voice-Model', model);
      res.setHeader('X-GEV-Voice-Profile', profile || 'standard');
      res.setHeader('X-GEV-Voice-Persona', resolveVoicePersona(persona));
      res.setHeader(
        'X-GEV-Voice-Auth',
        authMode === 'oauth' ? 'codex-oauth' : 'env',
      );
      // Captions are billed separately; the client meters them with this id.
      res.setHeader(
        'X-GEV-Voice-Transcribe-Model',
        transcription.transcription ? transcribeModel : 'off',
      );
      if (requestedTier && !isKnownVoiceTier(requestedTier)) {
        res.setHeader('X-GEV-Voice-Tier-Fallback', '1');
      }
      if (!response.ok) {
        console.warn(`[realtime-token] upstream HTTP ${response.status}`);
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.end(JSON.stringify({ error: 'Failed to create Realtime token' }));
        return;
      }
      res.setHeader(
        'Content-Type',
        response.headers.get('content-type') || 'application/json',
      );
      if (budget) budget.record(bucket); // Flight Eye: a successful mint
      res.end(body);
    } catch {
      // For a network fault this was a resolver message naming the upstream
      // host; the client only needs to know the mint failed.
      console.warn('[realtime-token] mint failed');
      res.statusCode = 502;
      res.setHeader('Content-Type', 'application/json');
      res.end(
        JSON.stringify({
          error: 'Failed to create Realtime token',
        }),
      );
    }
  };
}

export {
  createRealtimeOAuthLoginHandler,
  createRealtimeOAuthStatusHandler,
  createRealtimeTokenHandler,
};
