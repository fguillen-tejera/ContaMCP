import { env } from 'cloudflare:workers';
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { getOAuthApi } from '@cloudflare/workers-oauth-provider';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { z } from 'zod';
import { type AppEnv, oauthOptions } from '../src/auth/provider';
import worker from '../src/index';

export function bindings(overrides: Partial<AppEnv> = {}): AppEnv {
  return {
    ...env,
    APP_ORIGIN: 'http://localhost:8787',
    APP_ENV: 'local',
    OAUTH_RATE_LIMIT: { limit: async () => ({ success: true }) },
    MCP_RATE_LIMIT: { limit: async () => ({ success: true }) },
    ...overrides,
  };
}

export async function dispatch(request: Request, config = bindings()) {
  const ctx = createExecutionContext();
  const response = await worker.fetch(request, config, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

export async function principal(
  config: AppEnv,
  scopes = ['expenses:read', 'expenses:write', 'ledger:read', 'ledger:write'],
  identity?: { userId: string; subject: string },
) {
  const { userId, subject } = identity ?? {
    userId: crypto.randomUUID(),
    subject: crypto.randomUUID(),
  };
  if (!identity)
    await config.DB.prepare('INSERT INTO users (id, google_subject, created_at) VALUES (?, ?, ?)')
      .bind(userId, subject, new Date().toISOString())
      .run();
  const oauth = getOAuthApi(oauthOptions(config), config);
  const client = await oauth.createClient({
    redirectUris: ['https://client.example/callback'],
    tokenEndpointAuthMethod: 'none',
    grantTypes: ['authorization_code', 'refresh_token'],
    responseTypes: ['code'],
  });
  const verifier = 'v'.repeat(64);
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  const challenge = btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replaceAll('=', '');
  const authorize = new URL(`${config.APP_ORIGIN}/authorize`);
  authorize.search = new URLSearchParams({
    client_id: client.clientId,
    redirect_uri: client.redirectUris[0] ?? '',
    response_type: 'code',
    scope: scopes.join(' '),
    code_challenge: challenge,
    code_challenge_method: 'S256',
    resource: `${config.APP_ORIGIN}/mcp`,
    state: crypto.randomUUID(),
  }).toString();
  // Only tests seed a verified identity. Production reaches this helper after Google JWT validation.
  const grant = await oauth.completeAuthorization({
    request: await oauth.parseAuthRequest(new Request(authorize)),
    userId,
    metadata: {},
    scope: scopes,
    props: { userId, googleSubject: subject },
  });
  const response = await dispatch(
    new Request(`${config.APP_ORIGIN}/oauth/token`, {
      method: 'POST',
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: client.clientId,
        code: new URL(grant.redirectTo).searchParams.get('code') ?? '',
        redirect_uri: client.redirectUris[0] ?? '',
        code_verifier: verifier,
        resource: `${config.APP_ORIGIN}/mcp`,
      }),
    }),
    config,
  );
  const tokens = z
    .object({ access_token: z.string(), refresh_token: z.string().optional() })
    .parse(await response.json());
  return {
    userId,
    subject,
    token: tokens.access_token,
    refreshToken: tokens.refresh_token,
    clientId: client.clientId,
  };
}

export async function connect(config: AppEnv, token: string) {
  const client = new Client({ name: 'contamcp-integration-test', version: '1.0.0' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${config.APP_ORIGIN}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
      fetch: (input, init) => dispatch(new Request(input, init), config),
    }),
  );
  return client;
}

export function expenseInput(overrides: Record<string, unknown> = {}) {
  return {
    description: 'Gasolina',
    amount: '450.00',
    currency: 'MXN',
    date: '2026-10-23',
    category: 'transport',
    idempotencyKey: crypto.randomUUID(),
    ...overrides,
  };
}
