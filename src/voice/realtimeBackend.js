import { DEFAULT_VOICE_TIER, resolveVoiceModel } from './voiceCost.js';

/** Realtime-compatible token and SDP requests, independent of microphone/UI ownership. */
export function createRealtimeBackend({
  tokenEndpoint = '/api/realtime/token',
  callsEndpoint = 'https://api.openai.com/v1/realtime/calls',
  tokenTransport = (...args) => fetch(...args),
  connectionTransport = (...args) => fetch(...args),
  timeoutMs = 30_000,
  // A trimmed build names its voice profile (server/providers/openai/
  // profiles.js) so the session is minted with that build's tools only.
  profile = globalThis.GEV_VOICE_PROFILE ?? null,
  // Flight Eye names its voice persona (src/voice/personas.js) the same way.
  persona = globalThis.GEV_VOICE_PERSONA ?? null,
  signal: lifetime,
} = {}) {
  const scoped = (signal) =>
    AbortSignal.any(
      [lifetime, signal, AbortSignal.timeout(timeoutMs)].filter(Boolean),
    );
  return Object.freeze({
    protocol: 'openai-realtime',
    async requestToken({
      tier = DEFAULT_VOICE_TIER,
      authMode = 'api-key',
      signal,
    } = {}) {
      signal = scoped(signal);
      signal.throwIfAborted();
      const separator = tokenEndpoint.includes('?') ? '&' : '?';
      const query = new URLSearchParams({
        tier: resolveVoiceModel(tier).tier,
      });
      if (authMode === 'oauth') query.set('auth', 'oauth');
      if (profile) query.set('profile', String(profile));
      if (persona) query.set('persona', String(persona));
      const url = `${tokenEndpoint}${separator}${query}`;
      // Flight Eye: the phone shell sets window.FLIGHT_EYE_APP_KEY, which the
      // hosted server requires as X-FlightEye-App-Key (GEV_APP_KEY). Read per
      // request, since the shell injects it after the page loads; the
      // standard app has no key and sends no header.
      const appKey = globalThis.FLIGHT_EYE_APP_KEY;
      const headers =
        typeof appKey === 'string' && appKey
          ? { 'X-FlightEye-App-Key': appKey }
          : undefined;
      const response = await tokenTransport(url, {
        signal,
        cache: 'no-store',
        redirect: 'error',
        ...(headers ? { headers } : {}),
      });
      signal.throwIfAborted();
      const data = await response.json().catch(() => null);
      signal.throwIfAborted();
      if (!response.ok) {
        const reason =
          typeof data?.error === 'string' ? data.error : data?.error?.message;
        throw new Error(
          reason || `Realtime token failed: HTTP ${response.status}`,
        );
      }
      const token =
        data?.value || data?.client_secret?.value || data?.client_secret;
      if (typeof token !== 'string' || !token)
        throw new Error(
          'Realtime token response did not include a client secret',
        );
      const expiresAt = data?.expires_at ?? data?.client_secret?.expires_at;
      if (
        expiresAt != null &&
        (!Number.isFinite(expiresAt) || expiresAt * 1000 <= Date.now())
      )
        throw new Error(
          'Realtime client secret has expired; reconnect to request a new one',
        );
      return {
        token,
        model:
          response.headers?.get?.('X-GEV-Voice-Model') ||
          data?.session?.model ||
          null,
        tier: response.headers?.get?.('X-GEV-Voice-Tier') || null,
        transcribeModel:
          response.headers?.get?.('X-GEV-Voice-Transcribe-Model') || null,
        expiresAt,
      };
    },
    async negotiate({ offerSdp, credential, signal }) {
      signal = scoped(signal);
      signal.throwIfAborted();
      if (
        credential.expiresAt != null &&
        credential.expiresAt * 1000 <= Date.now()
      )
        throw new Error(
          'Realtime client secret has expired; reconnect to request a new one',
        );
      const response = await connectionTransport(callsEndpoint, {
        method: 'POST',
        body: offerSdp,
        signal,
        redirect: 'error',
        cache: 'no-store',
        headers: {
          Authorization: `Bearer ${credential.token}`,
          'Content-Type': 'application/sdp',
        },
      });
      signal.throwIfAborted();
      if (!response.ok) {
        await response.body?.cancel?.().catch(() => {});
        throw new Error(`Realtime SDP failed: HTTP ${response.status}`);
      }
      const answer = await response.text();
      signal.throwIfAborted();
      return answer;
    },
  });
}
