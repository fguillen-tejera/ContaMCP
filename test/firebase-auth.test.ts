import { getOAuthApi } from '@cloudflare/workers-oauth-provider';
import { SignJWT, exportJWK, generateKeyPair } from 'jose';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { firebaseConfig, firebaseIdentity } from '../src/auth/firebase';
import { type AppEnv, oauthOptions } from '../src/auth/provider';
import { identityOwner } from '../src/db/identity';
import { automaticRecordingOwners } from '../src/db/automatic';
import { bindings, connect, dispatch, expenseInput, principal } from './helpers';

const uid = 'synthetic-firebase-reviewer';
const credentials = { email: 'reviewer@example.com', password: 'synthetic-password-not-real' };
const config = () =>
  bindings({
    GOOGLE_CLIENT_ID: 'synthetic-google-client',
    GOOGLE_CLIENT_SECRET: 'synthetic-google-secret',
    FIREBASE_PROJECT_ID: 'synthetic-firebase-project',
    FIREBASE_WEB_API_KEY: 'synthetic-firebase-key',
    FIREBASE_ALLOWED_UIDS: uid,
  });
let keyPair: Awaited<ReturnType<typeof generateKeyPair>>;
let publicKey: Awaited<ReturnType<typeof exportJWK>>;
beforeAll(async () => {
  keyPair = await generateKeyPair('RS256', { extractable: true });
  publicKey = {
    ...(await exportJWK(keyPair.publicKey)),
    kid: 'firebase-test',
    alg: 'RS256',
    use: 'sig',
  };
});
afterEach(() => vi.restoreAllMocks());

async function idToken(
  changes: {
    issuer?: string;
    audience?: string | string[];
    subject?: string;
    provider?: string;
    authTime?: number;
    expired?: boolean;
    key?: CryptoKey;
  } = {},
) {
  return new SignJWT({
    auth_time: changes.authTime ?? Math.floor(Date.now() / 1000),
    firebase: { sign_in_provider: changes.provider ?? 'password' },
  })
    .setProtectedHeader({ alg: 'RS256', kid: 'firebase-test' })
    .setIssuer(changes.issuer ?? 'https://securetoken.google.com/synthetic-firebase-project')
    .setAudience(changes.audience ?? 'synthetic-firebase-project')
    .setSubject(changes.subject ?? uid)
    .setIssuedAt()
    .setExpirationTime(changes.expired ? '-2m' : '5m')
    .sign(changes.key ?? keyPair.privateKey);
}

function mockFirebase(token: string, options: { status?: number; localId?: string } = {}) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    if (url.origin === 'https://identitytoolkit.googleapis.com') {
      expect(url.pathname).toBe('/v1/accounts:signInWithPassword');
      expect(url.searchParams.get('key')).toBe('synthetic-firebase-key');
      expect(JSON.parse(String(init?.body))).toEqual({ ...credentials, returnSecureToken: true });
      return Response.json(
        { idToken: token, localId: options.localId ?? uid },
        { status: options.status ?? 200 },
      );
    }
    if (
      url.href ===
      'https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com'
    )
      return Response.json({ keys: [publicKey] });
    throw new Error('Unexpected external request in test.');
  });
}

async function begin(
  env = config(),
  redirect = 'https://client.example/callback',
  scope = 'ledger:read ledger:write',
) {
  const oauth = getOAuthApi(oauthOptions(env), env);
  const client = await oauth.createClient({
    redirectUris: [redirect],
    tokenEndpointAuthMethod: 'none',
  });
  const verifier = 'v'.repeat(64);
  const challenge = btoa(
    String.fromCharCode(
      ...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))),
    ),
  )
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replaceAll('=', '');
  const url = new URL(`${env.APP_ORIGIN}/authorize`);
  url.search = new URLSearchParams({
    client_id: client.clientId,
    redirect_uri: redirect,
    response_type: 'code',
    state: 'synthetic-state',
    scope,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    resource: `${env.APP_ORIGIN}/mcp`,
  }).toString();
  const response = await dispatch(new Request(url), env);
  expect(response.status).toBe(200);
  const html = await response.text();
  const handle = html.match(/name="handle" value="([^"]+)"/)?.[1];
  if (!handle) throw new Error('Missing consent handle.');
  return { env, client, redirect, verifier, response, html, handle };
}

function cookie(response: Response) {
  return response.headers
    .getSetCookie()
    .map((value) => value.split(';')[0])
    .join('; ');
}

async function signIn(
  started: Awaited<ReturnType<typeof begin>>,
  overrides: Record<string, string> = {},
) {
  return dispatch(
    new Request(`${started.env.APP_ORIGIN}/authorize`, {
      method: 'POST',
      headers: { Origin: started.env.APP_ORIGIN, Cookie: cookie(started.response) },
      body: new URLSearchParams({
        handle: started.handle,
        decision: 'approve',
        provider: 'firebase',
        ...credentials,
        ...overrides,
      }),
    }),
    started.env,
  );
}

async function exchange(started: Awaited<ReturnType<typeof begin>>, response: Response) {
  expect(response.status).toBe(302);
  const returned = new URL(response.headers.get('Location') ?? '');
  expect(returned.origin).toBe('https://client.example');
  expect(returned.searchParams.get('state')).toBe('synthetic-state');
  const tokenResponse = await dispatch(
    new Request(`${started.env.APP_ORIGIN}/oauth/token`, {
      method: 'POST',
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: started.client.clientId,
        redirect_uri: started.redirect,
        code: returned.searchParams.get('code') ?? '',
        code_verifier: started.verifier,
        resource: `${started.env.APP_ORIGIN}/mcp`,
      }),
    }),
    started.env,
  );
  expect(tokenResponse.status).toBe(200);
  return z
    .object({ access_token: z.string(), refresh_token: z.string() })
    .parse(await tokenResponse.json());
}

describe('Firebase password identity', () => {
  it.each([
    { FIREBASE_PROJECT_ID: '' },
    { FIREBASE_PROJECT_ID: 'https://attacker.example' },
    { FIREBASE_WEB_API_KEY: undefined },
    { FIREBASE_WEB_API_KEY: ' ' },
    { FIREBASE_ALLOWED_UIDS: '' },
    { FIREBASE_ALLOWED_UIDS: Array.from({ length: 101 }, (_, i) => `uid-${i}`).join(',') },
  ])('keeps incomplete or invalid Firebase configuration disabled: %j', (overrides) => {
    expect(firebaseConfig(configWith(overrides))).toBeUndefined();
  });

  it('verifies a password sign-in and returns only its provider and stable UID', async () => {
    mockFirebase(await idToken());
    const env = firebaseConfig(config());
    if (!env) throw new Error('Missing synthetic config.');
    expect(await firebaseIdentity(env, credentials)).toEqual({
      provider: 'firebase',
      subject: uid,
    });
  });

  it.each([
    { issuer: 'https://attacker.example' },
    { audience: 'another-project' },
    { audience: ['synthetic-firebase-project', 'another-project'] },
    { subject: 'not-allowlisted' },
    { provider: 'google.com' },
    { provider: 'anonymous' },
    { authTime: Math.floor(Date.now() / 1000) + 60 },
    { expired: true },
  ])('rejects an invalid token identity: %j', async (changes) => {
    mockFirebase(await idToken(changes), { localId: changes.subject ?? uid });
    const env = firebaseConfig(config());
    if (!env) throw new Error('Missing synthetic config.');
    await expect(firebaseIdentity(env, credentials)).rejects.toThrow();
  });

  it('rejects invalid signatures, mismatched UIDs and upstream errors', async () => {
    const otherKey = await generateKeyPair('RS256');
    const env = firebaseConfig(config());
    if (!env) throw new Error('Missing synthetic config.');
    mockFirebase(await idToken({ key: otherKey.privateKey }));
    await expect(firebaseIdentity(env, credentials)).rejects.toThrow();
    vi.restoreAllMocks();
    mockFirebase(await idToken(), { localId: 'different-uid' });
    await expect(firebaseIdentity(env, credentials)).rejects.toThrow();
    vi.restoreAllMocks();
    mockFirebase('', { status: 500 });
    await expect(firebaseIdentity(env, credentials)).rejects.toThrow();
  });
});

function configWith(overrides: Partial<AppEnv>) {
  return { ...config(), ...overrides };
}

describe('Firebase OAuth and owner isolation', () => {
  it('offers a public connection landing page without accepting passwords outside an OAuth request', async () => {
    const response = await dispatch(new Request('http://localhost:8787/login'), config());
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain('http://localhost:8787/mcp');
    expect(html).not.toContain('type="password"');
    expect(response.headers.get('Content-Security-Policy')).toContain("default-src 'none'");
    expect(response.headers.get('Cache-Control')).toBe('no-store');
  });

  it('shows both authentication choices for ChatGPT when email accounts are enabled', async () => {
    const started = await begin(config(), 'https://chatgpt.com/connector_platform_oauth_redirect');
    expect(started.html).toContain('name="provider" value="firebase"');
    expect(started.html).toContain('type="password"');
    expect(started.html).toContain('Google');
    expect(started.html).not.toContain('synthetic-firebase-key');
    expect(started.response.headers.get('Content-Security-Policy')).toContain(
      "frame-ancestors 'none'",
    );
  });

  it('completes PKCE OAuth into a separate ledger and honors immediate UID removal', async () => {
    mockFirebase(await idToken());
    const started = await begin();
    const google = await principal(started.env);
    const tokens = await exchange(started, await signIn(started));
    const firebase = await connect(started.env, tokens.access_token);
    const originalGoogle = await connect(started.env, google.token);
    try {
      const created = await firebase.callTool({
        name: 'create_entry',
        arguments: { ...expenseInput(), type: 'expense' },
      });
      expect(created.isError).not.toBe(true);
      const own = await firebase.callTool({ name: 'list_entries', arguments: {} });
      expect(
        z.object({ entries: z.array(z.unknown()) }).parse(own.structuredContent).entries,
      ).toHaveLength(1);
      const other = await originalGoogle.callTool({ name: 'list_entries', arguments: {} });
      expect(
        z.object({ entries: z.array(z.unknown()) }).parse(other.structuredContent).entries,
      ).toHaveLength(0);
      expect(
        await started.env.DB.prepare('SELECT COUNT(*) AS count FROM users').first('count'),
      ).toBe(2);
      started.env.FIREBASE_ALLOWED_UIDS = 'another-allowed-uid';
      expect(
        (
          await dispatch(
            new Request(`${started.env.APP_ORIGIN}/mcp`, {
              headers: { Authorization: `Bearer ${tokens.access_token}` },
            }),
            started.env,
          )
        ).status,
      ).toBe(403);
      expect((await originalGoogle.listTools()).tools.length).toBeGreaterThan(0);
    } finally {
      await firebase.close();
      await originalGoogle.close();
    }
  });

  it('does not link providers on a colliding legacy subject and excludes Firebase from a Google job allowlist', async () => {
    const env = config();
    const firebaseOwner = await identityOwner(env.DB, { provider: 'firebase', subject: uid });
    expect(await identityOwner(env.DB, { provider: 'firebase', subject: uid })).toBe(firebaseOwner);
    await expect(identityOwner(env.DB, { provider: 'google', subject: uid })).rejects.toThrow();
    expect(await automaticRecordingOwners(env.DB, [uid])).toEqual([]);
  });

  it('preserves a Firebase read-only identity through refresh and honors token revocation', async () => {
    mockFirebase(await idToken());
    const started = await begin(config(), 'https://client.example/callback', 'ledger:read');
    const tokens = await exchange(started, await signIn(started));
    const refreshed = await dispatch(
      new Request(`${started.env.APP_ORIGIN}/oauth/token`, {
        method: 'POST',
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          client_id: started.client.clientId,
          refresh_token: tokens.refresh_token,
          resource: `${started.env.APP_ORIGIN}/mcp`,
        }),
      }),
      started.env,
    );
    expect(refreshed.status).toBe(200);
    const fresh = z.object({ access_token: z.string() }).parse(await refreshed.json());
    const client = await connect(started.env, fresh.access_token);
    try {
      const denied = await client.callTool({
        name: 'create_entry',
        arguments: { ...expenseInput(), type: 'expense' },
      });
      expect(denied.isError).toBe(true);
      expect(
        z.object({ error: z.object({ code: z.string() }) }).parse(denied.structuredContent).error
          .code,
      ).toBe('FORBIDDEN');
    } finally {
      await client.close();
    }
    const metadata = await dispatch(
      new Request(`${started.env.APP_ORIGIN}/.well-known/oauth-authorization-server`),
      started.env,
    );
    const discovery = z.object({ revocation_endpoint: z.string() }).parse(await metadata.json());
    const revoked = await dispatch(
      new Request(discovery.revocation_endpoint, {
        method: 'POST',
        body: new URLSearchParams({
          client_id: started.client.clientId,
          token: fresh.access_token,
          token_type_hint: 'access_token',
        }),
      }),
      started.env,
    );
    expect(revoked.status).toBe(200);
    expect(
      (
        await dispatch(
          new Request(`${started.env.APP_ORIGIN}/mcp`, {
            headers: { Authorization: `Bearer ${fresh.access_token}` },
          }),
          started.env,
        )
      ).status,
    ).toBe(401);
  });

  it('requires the browser binding and rejects owner injection before sending credentials upstream', async () => {
    const upstream = mockFirebase(await idToken());
    const started = await begin();
    expect((await signIn(started, { ownerId: crypto.randomUUID() })).status).toBe(400);
    const missingCookie = await dispatch(
      new Request(`${started.env.APP_ORIGIN}/authorize`, {
        method: 'POST',
        body: new URLSearchParams({
          handle: started.handle,
          decision: 'approve',
          provider: 'firebase',
          ...credentials,
        }),
      }),
      started.env,
    );
    expect(missingCookie.status).toBe(400);
    expect(upstream).not.toHaveBeenCalled();
  });

  it('gives failed sign-in a fresh transaction without echoing credentials or allowing replay', async () => {
    mockFirebase('', { status: 400 });
    const logs = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const started = await begin();
    const failed = await signIn(started);
    expect(failed.status).toBe(401);
    expect(failed.headers.get('Referrer-Policy')).toBe('strict-origin');
    const html = await failed.text();
    expect(html).toContain('role="alert"');
    expect(html).not.toContain(credentials.email);
    expect(html).not.toContain(credentials.password);
    expect(html.match(/name="handle" value="([^"]+)"/)?.[1]).not.toBe(started.handle);
    expect((await signIn(started)).status).toBe(400);
    expect(JSON.stringify(logs.mock.calls)).not.toContain(credentials.password);
    expect(JSON.stringify(logs.mock.calls)).not.toContain(credentials.email);
  });
});
