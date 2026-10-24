import { createRemoteJWKSet, jwtVerify } from 'jose';
import { z } from 'zod';

const googleKeys = createRemoteJWKSet(new URL('https://www.googleapis.com/oauth2/v3/certs'));
export type GoogleConfig = { clientId: string; clientSecret: string; redirectUri: string };
export type GoogleState = { verifier: string; nonce: string };

export async function googleAuthorizationUrl(
  config: GoogleConfig,
  state: string,
  data: GoogleState,
) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(data.verifier));
  const challenge = btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  url.search = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    response_type: 'code',
    scope: 'openid',
    state,
    nonce: data.nonce,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    prompt: 'select_account',
  }).toString();
  return url.toString();
}

export async function googleSubject(config: GoogleConfig, code: string, data: GoogleState) {
  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: config.clientId,
      client_secret: config.clientSecret,
      redirect_uri: config.redirectUri,
      grant_type: 'authorization_code',
      code_verifier: data.verifier,
    }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error('Google code exchange failed.');
  const { id_token } = z.object({ id_token: z.string().max(16_384) }).parse(await response.json());
  const { payload } = await jwtVerify(id_token, googleKeys, {
    issuer: ['https://accounts.google.com', 'accounts.google.com'],
    audience: config.clientId,
    algorithms: ['RS256'],
    maxTokenAge: '10 minutes',
    clockTolerance: 5,
    requiredClaims: ['sub', 'iat', 'exp', 'nonce'],
  });
  if (
    payload.nonce !== data.nonce ||
    (Array.isArray(payload.aud) && payload.aud.length > 1 && payload.azp !== config.clientId) ||
    (payload.azp !== undefined && payload.azp !== config.clientId)
  ) {
    throw new Error('Google identity binding failed.');
  }
  return z.string().min(1).max(255).parse(payload.sub);
}
