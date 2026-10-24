import { getOAuthApi } from '@cloudflare/workers-oauth-provider';
import {
  auth,
  type OAuthClientProvider,
  type OAuthDiscoveryState,
  type StoredOAuthClientInformation,
  type StoredOAuthTokens,
} from '@modelcontextprotocol/client';
import { SignJWT, exportJWK, generateKeyPair } from 'jose';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { oauthOptions } from '../src/auth/provider';
import { googleSubject } from '../src/auth/google';
import { isChatGptConnection } from '../src/auth/chatgpt';
import { bindings, connect, dispatch, expenseInput, principal } from './helpers';

const config = () =>
  bindings({
    GOOGLE_CLIENT_ID: 'synthetic-google-client',
    GOOGLE_CLIENT_SECRET: 'synthetic-test-only',
  });
let keyPair: Awaited<ReturnType<typeof generateKeyPair>>;
let publicKey: Awaited<ReturnType<typeof exportJWK>>;
beforeAll(async () => {
  keyPair = await generateKeyPair('RS256', { extractable: true });
  publicKey = {
    ...(await exportJWK(keyPair.publicKey)),
    kid: 'test-google-key',
    alg: 'RS256',
    use: 'sig',
  };
});
afterEach(() => {
  vi.restoreAllMocks();
});

async function idToken(
  overrides: {
    nonce?: string;
    audience?: string | string[];
    azp?: string;
    issuer?: string;
    subject?: string;
    expired?: boolean;
  } = {},
) {
  return new SignJWT({ nonce: overrides.nonce ?? 'test-nonce', azp: overrides.azp })
    .setProtectedHeader({ alg: 'RS256', kid: 'test-google-key' })
    .setIssuer(overrides.issuer ?? 'https://accounts.google.com')
    .setAudience(overrides.audience ?? 'synthetic-google-client')
    .setSubject(overrides.subject ?? 'synthetic-google-subject')
    .setIssuedAt()
    .setExpirationTime(overrides.expired ? '0 seconds' : '5m')
    .sign(keyPair.privateKey);
}

function mockGoogle(token: string) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = input instanceof Request ? input.url : input.toString();
    if (url === 'https://oauth2.googleapis.com/token') return Response.json({ id_token: token });
    if (url === 'https://www.googleapis.com/oauth2/v3/certs')
      return Response.json({ keys: [publicKey] });
    throw new Error('Unexpected external request in test.');
  });
}

async function beginAuthorization(
  options: { scope?: string; language?: string; redirectUris?: string[]; clientName?: string } = {},
) {
  const env = config();
  const oauth = getOAuthApi(oauthOptions(env), env);
  const client = await oauth.createClient({
    redirectUris: options.redirectUris ?? ['https://client.example/callback'],
    tokenEndpointAuthMethod: 'none',
    clientName: options.clientName ?? '<script>Untrusted client</script>',
  });
  const verifier = 'z'.repeat(64);
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
    redirect_uri: client.redirectUris[0] ?? '',
    response_type: 'code',
    state: 'client-state',
    scope: options.scope ?? 'expenses:read expenses:write',
    code_challenge: challenge,
    code_challenge_method: 'S256',
    resource: `${env.APP_ORIGIN}/mcp`,
  }).toString();
  const consent = await dispatch(
    new Request(url, { headers: { 'Accept-Language': options.language ?? 'es-MX' } }),
    env,
  );
  return { env, client, verifier, consent, url };
}

async function startAuthorization(options: Parameters<typeof beginAuthorization>[0] = {}) {
  const { env, client, verifier, consent, url } = await beginAuthorization(options);
  const html = await consent.text();
  expect(consent.status).toBe(200);
  expect(consent.headers.get('Referrer-Policy')).toBe('strict-origin');
  expect(consent.headers.get('Content-Security-Policy')).toContain("frame-ancestors 'none'");
  expect(consent.headers.get('Content-Security-Policy')).toContain(
    "form-action 'self' https://accounts.google.com;",
  );
  expect(html).not.toContain('<script>');
  expect(html).toContain('client.example');
  const handle = html.match(/name="handle" value="([^"]+)"/)?.[1];
  expect(handle).toBeDefined();
  const cookie = (consent.headers.get('Set-Cookie') ?? '').split(';')[0] ?? '';
  const form = new URLSearchParams({ handle: handle ?? '', decision: 'approve' });
  return { env, client, verifier, form, cookie, html, consent, url };
}

function approvalCookie(response: Response) {
  return (
    (response.headers.get('Set-Cookie') ?? '')
      .split(',')
      .map((part) => part.trim())
      .find((part) => part.startsWith('__Host-oauth-approvals='))
      ?.split(';')[0] ?? ''
  );
}

async function approveConnection(options: Parameters<typeof startAuthorization>[0] = {}) {
  const started = await startAuthorization(options);
  const approved = await dispatch(
    new Request(`${started.env.APP_ORIGIN}/authorize`, {
      method: 'POST',
      body: started.form,
      headers: { Cookie: started.cookie, Origin: started.env.APP_ORIGIN },
    }),
    started.env,
  );
  expect(approved.status).toBe(302);
  const cookie = approvalCookie(approved);
  expect(cookie.length > 0).toBe(true);
  return { ...started, approved, approval: cookie };
}

describe('OAuth and verified Google identity', () => {
  it.each([
    'https://chatgpt.com/connector_platform_oauth_redirect',
    'https://chatgpt.com/connector/oauth/synthetic_callback-123',
  ])('sends a new registered ChatGPT connection directly to Google: %s', async (redirectUri) => {
    const { env, consent, url } = await beginAuthorization({
      redirectUris: [redirectUri],
      scope: 'ledger:read',
    });
    expect(consent.status).toBe(302);
    const first = new URL(consent.headers.get('Location') ?? '');
    expect(first.origin).toBe('https://accounts.google.com');
    expect(first.searchParams.get('scope')).toBe('openid');
    expect(first.searchParams.get('code_challenge_method')).toBe('S256');
    expect(consent.headers.get('Set-Cookie')).toContain('__Host-oauth-upstream-');
    expect(consent.headers.get('Set-Cookie')).not.toContain('__Host-oauth-consent-');
    expect(consent.headers.get('Set-Cookie')).not.toContain('__Host-oauth-approvals=');
    const repeat = await dispatch(new Request(url), env);
    expect(repeat.status).toBe(302);
    const second = new URL(repeat.headers.get('Location') ?? '');
    for (const field of ['state', 'nonce', 'code_challenge']) {
      expect(first.searchParams.has(field)).toBe(true);
      expect(first.searchParams.get(field) === second.searchParams.get(field)).toBe(false);
    }
    expect(await env.DB.prepare('SELECT COUNT(*) n FROM users').first('n')).toBe(0);
    const cookie = (consent.headers.get('Set-Cookie') ?? '').split(';')[0] ?? '';
    const callback = new URL(`${env.APP_ORIGIN}/auth/google/callback`);
    callback.searchParams.set('state', first.searchParams.get('state') ?? '');
    const upstream = await getOAuthApi(oauthOptions(env), env).finishUpstream(
      new Request(callback, { headers: { Cookie: cookie } }),
    );
    expect(upstream.request.scope).toEqual(['ledger:read']);
  });

  it('does not trust an app name, homepage or request headers as proof of ChatGPT', async () => {
    const { env, consent, url } = await beginAuthorization({ clientName: 'ChatGPT' });
    expect(consent.status).toBe(200);
    const response = await dispatch(
      new Request(url, {
        headers: {
          Referer: 'https://chatgpt.com/',
          'User-Agent': 'ChatGPT',
          'X-ChatGPT-Client': 'true',
        },
      }),
      env,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('Location')).toBeNull();
  });

  it('keeps approval for mixed registrations and rejects a ChatGPT callback not registered to the selected client', async () => {
    const stable = 'https://chatgpt.com/connector_platform_oauth_redirect';
    const mixed = await beginAuthorization({
      redirectUris: [stable, 'https://client.example/callback'],
    });
    expect(mixed.consent.status).toBe(200);
    const foreign = new URL(mixed.url);
    foreign.searchParams.set('redirect_uri', 'https://client.example/callback');
    expect((await dispatch(new Request(foreign), mixed.env)).status).toBe(200);
    const external = await beginAuthorization();
    const forged = new URL(external.url);
    forged.searchParams.set('redirect_uri', stable);
    const rejected = await dispatch(new Request(forged), external.env);
    expect(rejected.status).toBe(400);
    expect(rejected.headers.get('Location')).toBeNull();
    forged.searchParams.set('client_id', 'synthetic-unregistered-client');
    expect((await dispatch(new Request(forged), external.env)).status).toBe(400);
  });

  it.each([
    'http://chatgpt.com/connector_platform_oauth_redirect',
    'https://chatgpt.com.attacker.example/connector_platform_oauth_redirect',
    'https://chatgpt.com@attacker.example/connector_platform_oauth_redirect',
    'https://attacker.example@chatgpt.com/connector_platform_oauth_redirect',
    'https://chatgpt.com:8443/connector_platform_oauth_redirect',
    'https://chatgpt.com:443/connector_platform_oauth_redirect',
    'https://CHATGPT.com/connector_platform_oauth_redirect',
    'https://chatgpt.com./connector_platform_oauth_redirect',
    'https://chatgpt.com/connector_platform_oauth_redirect?next=https://attacker.example',
    'https://chatgpt.com/connector_platform_oauth_redirect#fragment',
    'https://chatgpt.com/connector_platform_oauth_redirect/',
    'https://chatgpt.com/unrelated',
    'https://chatgpt.com/connector/oauth/',
    'https://chatgpt.com/connector/oauth/example/extra',
    'https://chatgpt.com/connector/oauth/../connector_platform_oauth_redirect',
    'https://chatgpt.com/connector/oauth/%65xample',
    'https://chatgpt.com/connector/oauth/example?',
    'https://chatgpt.com/connector/oauth/example\n',
  ])('does not preapprove a lookalike or modified callback: %s', async (redirectUri) => {
    const clientId = 'synthetic-client';
    expect(
      await isChatGptConnection(
        {
          lookupClient: async () => ({
            clientId,
            redirectUris: [redirectUri],
            clientName: 'ChatGPT',
            clientUri: 'https://chatgpt.com/',
            tokenEndpointAuthMethod: 'none' as const,
          }),
        },
        {
          clientId,
          redirectUri,
          responseType: 'code',
          scope: ['ledger:read'],
          state: 'synthetic-state',
        },
      ),
    ).toBe(false);
  });

  it('validates scope, PKCE and resource before allowing the ChatGPT shortcut', async () => {
    const { env, url } = await beginAuthorization({
      redirectUris: ['https://chatgpt.com/connector_platform_oauth_redirect'],
    });
    for (const [field, value] of [
      ['scope', 'ledger:write'],
      ['scope', 'admin'],
      ['code_challenge_method', 'plain'],
      ['code_challenge', 'invalid'],
      ['resource', 'https://other.example/mcp'],
    ]) {
      const invalid = new URL(url);
      invalid.searchParams.set(field ?? '', value ?? '');
      const response = await dispatch(new Request(invalid), env);
      expect([400, 302]).toContain(response.status);
      const destination = response.headers.get('Location');
      expect(
        destination ? new URL(destination).origin === 'https://accounts.google.com' : false,
      ).toBe(false);
      expect(response.headers.get('Set-Cookie') ?? '').not.toContain('__Host-oauth-upstream-');
    }
    expect(await env.DB.prepare('SELECT COUNT(*) n FROM users').first('n')).toBe(0);
  });

  it('still requires the Google browser binding and an allowed Google identity on the ChatGPT path', async () => {
    const { env, consent } = await beginAuthorization({
      redirectUris: ['https://chatgpt.com/connector_platform_oauth_redirect'],
    });
    const google = new URL(consent.headers.get('Location') ?? '');
    const callback = new URL(`${env.APP_ORIGIN}/auth/google/callback`);
    callback.search = new URLSearchParams({
      state: google.searchParams.get('state') ?? '',
      code: 'synthetic-google-code',
    }).toString();
    expect((await dispatch(new Request(callback), env)).status).toBe(400);
    const cookie = (consent.headers.get('Set-Cookie') ?? '').split(';')[0] ?? '';
    mockGoogle(await idToken({ nonce: google.searchParams.get('nonce') ?? '' }));
    const denied = await dispatch(new Request(callback, { headers: { Cookie: cookie } }), {
      ...env,
      ALLOWED_GOOGLE_SUBJECTS: 'different-synthetic-subject',
    });
    expect(denied.status).toBe(302);
    const destination = new URL(denied.headers.get('Location') ?? '');
    expect(destination.origin).toBe('https://chatgpt.com');
    expect(destination.searchParams.get('error')).toBe('access_denied');
    expect(destination.searchParams.has('code')).toBe(false);
    expect(await env.DB.prepare('SELECT COUNT(*) n FROM users').first('n')).toBe(0);
  });

  it('renders one Connect action with a readable access summary and no permission controls', async () => {
    const spanish = await startAuthorization();
    expect(spanish.html).toContain('lang="es-MX"');
    expect(spanish.html).toContain('name="viewport"');
    expect(spanish.html).toContain('Conectar con Google');
    expect(spanish.html).toContain('consultar y administrar tus gastos');
    expect(spanish.html).not.toContain('permission_');
    expect(spanish.html).not.toContain('name="scope"');
    expect(spanish.html).not.toContain('type="radio"');
    expect(spanish.html).not.toContain('type="checkbox"');
    const nonce = spanish.html.match(/<style nonce="([^"]+)"/)?.[1];
    expect(nonce).toBeTruthy();
    expect(spanish.consent.headers.get('Content-Security-Policy')).toContain(
      `style-src 'nonce-${nonce}'`,
    );
    const english = await startAuthorization({ scope: 'ledger:read', language: 'en-US' });
    expect(english.html).toContain('lang="en"');
    expect(english.html).toContain('Connect with Google');
    expect(english.html).toContain('It can read your financial records.');
    expect(english.html).not.toContain('read and manage');
  });

  it('approves only the stored requested scopes and rejects form-supplied permission changes', async () => {
    for (const scope of ['expenses:read', 'ledger:read ledger:write']) {
      const { env, form, cookie } = await startAuthorization({ scope });
      const approved = await dispatch(
        new Request(`${env.APP_ORIGIN}/authorize`, {
          method: 'POST',
          body: form,
          headers: { Cookie: cookie, Origin: env.APP_ORIGIN },
        }),
        env,
      );
      expect(approved.status).toBe(302);
      const location = new URL(approved.headers.get('Location') ?? '');
      expect(location.origin).toBe('https://accounts.google.com');
      const upstreamCookie =
        (approved.headers.get('Set-Cookie') ?? '')
          .split(',')
          .map((part) => part.trim())
          .find((part) => part.startsWith('__Host-oauth-upstream-'))
          ?.split(';')[0] ?? '';
      const callback = new URL(`${env.APP_ORIGIN}/auth/google/callback`);
      callback.searchParams.set('state', location.searchParams.get('state') ?? '');
      const upstream = await getOAuthApi(oauthOptions(env), env).finishUpstream(
        new Request(callback, { headers: { Cookie: upstreamCookie } }),
      );
      expect(upstream.request.scope).toEqual(scope.split(' '));
    }
    for (const field of ['scope', 'permission_ledger', 'userId', 'handle']) {
      const attempt = await startAuthorization({ scope: 'expenses:read' });
      attempt.form.append(field, field === 'scope' ? 'ledger:write' : 'forged');
      const response = await dispatch(
        new Request(`${attempt.env.APP_ORIGIN}/authorize`, {
          method: 'POST',
          body: attempt.form,
          headers: { Cookie: attempt.cookie, Origin: attempt.env.APP_ORIGIN },
        }),
        attempt.env,
      );
      expect(response.status).toBe(400);
      expect(response.headers.get('Location')).toBeNull();
    }
  });

  it('lets the user cancel without initiating Google authentication', async () => {
    const { env, form, cookie } = await startAuthorization();
    form.set('decision', 'deny');
    const response = await dispatch(
      new Request(`${env.APP_ORIGIN}/authorize`, {
        method: 'POST',
        body: form,
        headers: { Cookie: cookie, Origin: env.APP_ORIGIN },
      }),
      env,
    );
    expect(response.status).toBe(302);
    const redirect = new URL(response.headers.get('Location') ?? '');
    expect(redirect.origin).toBe('https://client.example');
    expect(redirect.searchParams.get('error')).toBe('access_denied');
    expect(response.headers.get('Set-Cookie')).not.toContain('__Host-oauth-upstream-');
    expect(response.headers.get('Set-Cookie')).not.toContain('__Host-oauth-approvals=');
  });

  it('remembers an explicit app approval and reconnects directly to Google with a fresh bound login', async () => {
    const { env, consent, approved, url, approval } = await approveConnection();
    expect(consent.headers.get('Set-Cookie')).not.toContain('__Host-oauth-approvals=');
    const stored =
      (approved.headers.get('Set-Cookie') ?? '')
        .split(',')
        .find((part) => part.trim().startsWith('__Host-oauth-approvals=')) ?? '';
    for (const attribute of ['Secure', 'HttpOnly', 'SameSite=Lax', 'Path=/', 'Max-Age=2592000'])
      expect(stored).toContain(attribute);
    const response = await dispatch(new Request(url, { headers: { Cookie: approval } }), env);
    expect(response.status).toBe(302);
    const destination = new URL(response.headers.get('Location') ?? '');
    const initial = new URL(approved.headers.get('Location') ?? '');
    expect(destination.origin).toBe('https://accounts.google.com');
    expect(destination.searchParams.get('code_challenge_method')).toBe('S256');
    expect(destination.searchParams.get('prompt')).toBe('select_account');
    expect(destination.searchParams.get('state') === initial.searchParams.get('state')).toBe(false);
    expect(destination.searchParams.get('nonce') === initial.searchParams.get('nonce')).toBe(false);
    expect(
      destination.searchParams.get('code_challenge') === initial.searchParams.get('code_challenge'),
    ).toBe(false);
    expect(response.headers.get('Set-Cookie')).toContain('__Host-oauth-upstream-');
    expect(response.headers.get('Set-Cookie')).not.toContain('__Host-oauth-consent-');
    expect(await env.DB.prepare('SELECT COUNT(*) n FROM users').first('n')).toBe(0);
    expect((await dispatch(new Request(url), env)).status).toBe(200);
  });

  it('requires new approval for broader permissions or a different registered return address', async () => {
    const { env, url, approval } = await approveConnection({
      scope: 'expenses:read',
      redirectUris: ['https://client.example/callback', 'https://client.example/alternate'],
    });
    const broader = new URL(url);
    broader.searchParams.set('scope', 'expenses:read expenses:write');
    const alternate = new URL(url);
    alternate.searchParams.set('redirect_uri', 'https://client.example/alternate');
    for (const request of [broader, alternate]) {
      const response = await dispatch(new Request(request, { headers: { Cookie: approval } }), env);
      expect(response.status).toBe(200);
      expect(response.headers.get('Location')).toBeNull();
      expect(await response.text()).toContain('Conectar con Google');
    }
  });

  it('keeps multiple app approvals separate and remembers both after explicit connection', async () => {
    const first = await approveConnection();
    const second = await startAuthorization();
    const unapproved = await dispatch(
      new Request(second.url, { headers: { Cookie: first.approval } }),
      second.env,
    );
    expect(unapproved.status).toBe(200);
    const connected = await dispatch(
      new Request(`${second.env.APP_ORIGIN}/authorize`, {
        method: 'POST',
        body: second.form,
        headers: { Cookie: `${second.cookie}; ${first.approval}`, Origin: second.env.APP_ORIGIN },
      }),
      second.env,
    );
    expect(connected.status).toBe(302);
    const combined = approvalCookie(connected);
    for (const started of [first, second]) {
      const response = await dispatch(
        new Request(started.url, { headers: { Cookie: combined } }),
        started.env,
      );
      expect(response.status).toBe(302);
      expect(new URL(response.headers.get('Location') ?? '').origin).toBe(
        'https://accounts.google.com',
      );
    }
  });

  it('uses the current narrower request rather than the remembered broader permissions', async () => {
    const { env, url, approval } = await approveConnection({ scope: 'ledger:read ledger:write' });
    const narrower = new URL(url);
    narrower.searchParams.set('scope', 'ledger:read');
    const response = await dispatch(new Request(narrower, { headers: { Cookie: approval } }), env);
    expect(response.status).toBe(302);
    const destination = new URL(response.headers.get('Location') ?? '');
    const upstreamCookie =
      (response.headers.get('Set-Cookie') ?? '')
        .split(',')
        .map((part) => part.trim())
        .find((part) => part.startsWith('__Host-oauth-upstream-'))
        ?.split(';')[0] ?? '';
    const callback = new URL(`${env.APP_ORIGIN}/auth/google/callback`);
    callback.searchParams.set('state', destination.searchParams.get('state') ?? '');
    const upstream = await getOAuthApi(oauthOptions(env), env).finishUpstream(
      new Request(callback, { headers: { Cookie: upstreamCookie } }),
    );
    expect(upstream.request.scope).toEqual(['ledger:read']);
  });

  it('shows first-time approval again for tampered, expired, or rotated-key cookies', async () => {
    const { env, url, approval } = await approveConnection();
    const tampered = approval.replace(
      /\.(.)/,
      (_match, char: string) => `.${char === 'A' ? 'B' : 'A'}`,
    );
    expect((await dispatch(new Request(url, { headers: { Cookie: tampered } }), env)).status).toBe(
      200,
    );
    expect(
      (
        await dispatch(new Request(url, { headers: { Cookie: approval } }), {
          ...env,
          GOOGLE_CLIENT_SECRET: 'synthetic-rotated-credentials',
        })
      ).status,
    ).toBe(200);
    const current = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(current + 31 * 86_400_000);
    try {
      const response = await dispatch(new Request(url, { headers: { Cookie: approval } }), env);
      expect(response.status).toBe(200);
      expect(response.headers.get('Location')).toBeNull();
    } finally {
      clock.mockRestore();
    }
  });

  it('supports SDK OAuth discovery, public DCR, S256 and issuer-bound code exchange', async () => {
    const env = config();
    let client: StoredOAuthClientInformation | undefined;
    let tokens: StoredOAuthTokens | undefined;
    let verifier = '';
    let discovery: OAuthDiscoveryState | undefined;
    let authorization: URL | undefined;
    const provider: OAuthClientProvider = {
      redirectUrl: 'http://127.0.0.1:12345/callback',
      clientMetadata: {
        redirect_uris: ['http://127.0.0.1:12345/callback'],
        token_endpoint_auth_method: 'none',
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
      },
      state: () => 'synthetic-sdk-state',
      clientInformation: () => client,
      saveClientInformation: (value) => {
        client = value;
      },
      tokens: () => tokens,
      saveTokens: (value) => {
        tokens = value;
      },
      codeVerifier: () => verifier,
      saveCodeVerifier: (value) => {
        verifier = value;
      },
      discoveryState: () => discovery,
      saveDiscoveryState: (value) => {
        discovery = value;
      },
      redirectToAuthorization: (url) => {
        authorization = url;
      },
    };
    const options = {
      serverUrl: `${env.APP_ORIGIN}/mcp`,
      scope: 'expenses:read expenses:write',
      fetchFn: (input: RequestInfo | URL, init?: RequestInit) =>
        dispatch(new Request(input, init), env),
    };
    expect(await auth(provider, options)).toBe('REDIRECT');
    expect(client).toBeDefined();
    expect(authorization).toBeDefined();
    const url = new URL(String(authorization));
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect((await dispatch(new Request(url), env)).status).toBe(200);
    const a = await principal(env);
    const grant = await getOAuthApi(oauthOptions(env), env).completeAuthorization({
      request: await getOAuthApi(oauthOptions(env), env).parseAuthRequest(new Request(url)),
      userId: a.userId,
      metadata: {},
      scope: ['expenses:read', 'expenses:write'],
      props: { userId: a.userId, googleSubject: a.subject },
    });
    const returned = new URL(grant.redirectTo);
    const callback = {
      ...options,
      authorizationCode: returned.searchParams.get('code') ?? '',
      iss: returned.searchParams.get('iss') ?? undefined,
    };
    const recordedDiscovery = discovery;
    expect(recordedDiscovery).toBeDefined();
    discovery = undefined;
    await expect(auth(provider, callback)).rejects.toThrow();
    discovery = recordedDiscovery;
    await expect(
      auth(provider, { ...callback, iss: 'https://wrong-issuer.example' }),
    ).rejects.toThrow();
    const correctVerifier = verifier;
    verifier = 'wrong-verifier'.repeat(4);
    await expect(auth(provider, callback)).rejects.toThrow();
    verifier = correctVerifier;
    expect(await auth(provider, callback)).toBe('AUTHORIZED');
    expect(tokens).toBeDefined();
    await expect(auth(provider, callback)).rejects.toThrow();
  });

  it.each([
    {
      name: 'custom MCP approval',
      redirectUri: 'https://client.example/callback',
      direct: false,
      scope: 'expenses:read expenses:write',
    },
    {
      name: 'ChatGPT stable callback',
      redirectUri: 'https://chatgpt.com/connector_platform_oauth_redirect',
      direct: true,
      scope: 'ledger:read ledger:write',
    },
    {
      name: 'ChatGPT connection callback',
      redirectUri: 'https://chatgpt.com/connector/oauth/synthetic-connection',
      direct: true,
      scope: 'ledger:read ledger:write',
    },
  ])(
    'completes $name, Google sign-in, PKCE exchange and an authenticated MCP write',
    async ({ redirectUri, direct, scope }) => {
      const options = { redirectUris: [redirectUri], scope };
      const started = direct
        ? { flow: 'google' as const, ...(await beginAuthorization(options)) }
        : { flow: 'approval' as const, ...(await startAuthorization(options)) };
      const { env, client, verifier } = started;
      const approved =
        started.flow === 'approval'
          ? await dispatch(
              new Request(`${env.APP_ORIGIN}/authorize`, {
                method: 'POST',
                body: started.form,
                headers: { Cookie: started.cookie, Origin: env.APP_ORIGIN },
              }),
              env,
            )
          : started.consent;
      expect(approved.status).toBe(302);
      const google = new URL(approved.headers.get('Location') ?? '');
      expect(google.origin).toBe('https://accounts.google.com');
      expect(google.searchParams.get('code_challenge_method')).toBe('S256');
      expect(google.searchParams.get('scope')).toBe('openid');
      mockGoogle(await idToken({ nonce: google.searchParams.get('nonce') ?? '' }));
      const callback = new URL(`${env.APP_ORIGIN}/auth/google/callback`);
      callback.search = new URLSearchParams({
        state: google.searchParams.get('state') ?? '',
        code: 'synthetic-google-code',
      }).toString();
      const upstreamCookie =
        (approved.headers.get('Set-Cookie') ?? '')
          .split(',')
          .map((part) => part.trim())
          .find((part) => part.startsWith('__Host-oauth-upstream-'))
          ?.split(';')[0] ?? '';
      const completed = await dispatch(
        new Request(callback, { headers: { Cookie: upstreamCookie } }),
        env,
      );
      expect(completed.status).toBe(302);
      const result = new URL(completed.headers.get('Location') ?? '');
      expect(result.origin).toBe(new URL(redirectUri).origin);
      expect(result.pathname).toBe(new URL(redirectUri).pathname);
      expect(result.searchParams.get('state')).toBe('client-state');
      expect(result.searchParams.get('code')).toBeTruthy();
      const exchange = await dispatch(
        new Request(`${env.APP_ORIGIN}/oauth/token`, {
          method: 'POST',
          body: new URLSearchParams({
            grant_type: 'authorization_code',
            client_id: client.clientId,
            code: result.searchParams.get('code') ?? '',
            redirect_uri: client.redirectUris[0] ?? '',
            code_verifier: verifier,
            resource: `${env.APP_ORIGIN}/mcp`,
          }),
        }),
        env,
      );
      const { access_token } = z.object({ access_token: z.string() }).parse(await exchange.json());
      const mcp = await connect(env, access_token);
      try {
        expect(
          (
            await mcp.callTool({
              name: direct ? 'create_entry' : 'create_expense',
              arguments: { ...expenseInput(), type: 'expense' },
            })
          ).isError,
        ).not.toBe(true);
      } finally {
        await mcp.close();
      }
      const replay = await dispatch(
        new Request(callback, { headers: { Cookie: upstreamCookie } }),
        env,
      );
      expect(replay.status).toBe(400);
    },
  );

  it('rejects forged consent and callback requests without their browser binding', async () => {
    const { env, form } = await startAuthorization();
    const response = await dispatch(
      new Request(`${env.APP_ORIGIN}/authorize`, { method: 'POST', body: form }),
      env,
    );
    expect(response.status).toBe(400);
    expect(
      await dispatch(
        new Request(`${env.APP_ORIGIN}/auth/google/callback?state=forged&code=forged`),
        env,
      ),
    ).toMatchObject({ status: 400 });
  });

  it.each([
    { audience: 'someone-else' },
    { nonce: 'wrong-nonce' },
    { issuer: 'https://attacker.example' },
    { azp: 'someone-else' },
    { audience: ['synthetic-google-client', 'other-client'] },
  ])('rejects Google ID tokens with invalid identity claims: %j', async (claims) => {
    mockGoogle(await idToken(claims));
    await expect(
      googleSubject(
        {
          clientId: 'synthetic-google-client',
          clientSecret: 'synthetic-test-only',
          redirectUri: 'http://localhost:8787/auth/google/callback',
        },
        'synthetic-code',
        { verifier: 'v'.repeat(64), nonce: 'test-nonce' },
      ),
    ).rejects.toThrow();
  });

  it('rejects expired and unsigned/unverifiable Google tokens', async () => {
    const token = await new SignJWT({ nonce: 'test-nonce' })
      .setProtectedHeader({ alg: 'RS256', kid: 'test-google-key' })
      .setIssuer('https://accounts.google.com')
      .setAudience('synthetic-google-client')
      .setSubject('synthetic')
      .setIssuedAt(Math.floor(Date.now() / 1000) - 600)
      .setExpirationTime(Math.floor(Date.now() / 1000) - 60)
      .sign(keyPair.privateKey);
    mockGoogle(token);
    const google = {
      clientId: 'synthetic-google-client',
      clientSecret: 'synthetic-test-only',
      redirectUri: 'http://localhost:8787/auth/google/callback',
    };
    await expect(
      googleSubject(google, 'code', { verifier: 'v'.repeat(64), nonce: 'test-nonce' }),
    ).rejects.toThrow();
    vi.restoreAllMocks();
    mockGoogle('not-a-signed-jwt');
    await expect(
      googleSubject(google, 'code', { verifier: 'v'.repeat(64), nonce: 'test-nonce' }),
    ).rejects.toThrow();
  });

  it('leaves sign-in inaccessible until credentials exist', async () => {
    const response = await dispatch(new Request('http://localhost:8787/authorize'));
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'oauth_not_configured' });
  });

  it('refreshes and revokes actual OAuth tokens without trusting user headers', async () => {
    const env = bindings();
    const user = await principal(env);
    const refreshed = await dispatch(
      new Request(`${env.APP_ORIGIN}/oauth/token`, {
        method: 'POST',
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          client_id: user.clientId,
          refresh_token: user.refreshToken ?? '',
          resource: `${env.APP_ORIGIN}/mcp`,
        }),
      }),
      env,
    );
    const { access_token } = z.object({ access_token: z.string() }).parse(await refreshed.json());
    const mcp = await connect(env, access_token);
    await mcp.close();
    const metadata = await dispatch(
      new Request(`${env.APP_ORIGIN}/.well-known/oauth-authorization-server`),
      env,
    );
    const { revocation_endpoint } = z
      .object({ revocation_endpoint: z.string() })
      .parse(await metadata.json());
    const revoke = await dispatch(
      new Request(revocation_endpoint, {
        method: 'POST',
        body: new URLSearchParams({
          client_id: user.clientId,
          token: access_token,
          token_type_hint: 'access_token',
        }),
      }),
      env,
    );
    expect(revoke.status).toBe(200);
    expect(
      (
        await dispatch(
          new Request(`${env.APP_ORIGIN}/mcp`, {
            headers: { Authorization: `Bearer ${access_token}` },
          }),
          env,
        )
      ).status,
    ).toBe(401);
  });

  it('enforces pilot subject restrictions on existing tokens', async () => {
    const env = bindings();
    const user = await principal(env);
    expect(
      (
        await dispatch(
          new Request(`${env.APP_ORIGIN}/mcp`, {
            headers: { Authorization: `Bearer ${user.token}` },
          }),
          { ...env, ALLOWED_GOOGLE_SUBJECTS: 'different-subject' },
        )
      ).status,
    ).toBe(403);
  });

  it('rejects untrusted hosts, browser origins, and oversized streamed requests', async () => {
    expect((await dispatch(new Request('http://attacker.example/mcp'))).status).toBe(421);
    expect(
      (
        await dispatch(
          new Request('http://localhost:8787/mcp', {
            headers: { Origin: 'https://attacker.example' },
          }),
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await dispatch(
          new Request('http://localhost:8787/authorize', {
            method: 'POST',
            headers: { Origin: 'null' },
          }),
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await dispatch(
          new Request('http://localhost:8787/oauth/register', {
            method: 'POST',
            body: 'x'.repeat(16_385),
          }),
        )
      ).status,
    ).toBe(413);
  });
});
