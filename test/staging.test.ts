import { getOAuthApi } from '@cloudflare/workers-oauth-provider';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runReadOnlyScenario, runScenarios } from '../scripts/mcp-scenarios';
import { allowedSubject, oauthOptions } from '../src/auth/provider';
import { bindings, connect, dispatch, expenseInput, principal } from './helpers';

afterEach(() => vi.restoreAllMocks());

describe('staging safeguards and client acceptance scenarios', () => {
  it('keeps financial inputs and database exceptions out of tool errors and logs', async () => {
    const log = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const env = bindings();
    const a = await principal(env);
    const client = await connect(env, a.token);
    const marker = 'SYNTHETIC-sensitive-database-error';
    await env.DB.exec(
      `CREATE TRIGGER staging_test_failure BEFORE INSERT ON expense_mutations BEGIN SELECT RAISE(ABORT, '${marker}'); END`,
    );
    try {
      const result = await client.callTool({
        name: 'create_expense',
        arguments: expenseInput({ description: marker }),
      });
      expect(result).toMatchObject({
        isError: true,
        structuredContent: { error: { code: 'INTERNAL_ERROR' } },
      });
      expect(JSON.stringify(result)).not.toContain(marker);
      expect(log.mock.calls.flat().join(' ')).not.toContain(marker);
      expect(log).toHaveBeenCalledWith(expect.stringContaining('"event":"tool_failed"'));
      expect(await env.DB.prepare('SELECT COUNT(*) AS count FROM expenses').first('count')).toBe(0);
    } finally {
      await client.close();
      await env.DB.exec('DROP TRIGGER staging_test_failure');
    }
  });

  it('runs the independent-client scenario assertions against the runtime ledger', async () => {
    const env = bindings();
    const a = await principal(env);
    const b = await principal(env);
    expect(
      await runScenarios((account) => connect(env, account === 'A' ? a.token : b.token)),
    ).toEqual({ scenarios: 12, syntheticRecordsCreated: 2 });
    expect(
      await env.DB.prepare('SELECT COUNT(*) AS count FROM expense_mutations').first('count'),
    ).toBe(3);
  });

  it('fails the two-account acceptance test when the same identity is used twice', async () => {
    const env = bindings();
    const a = await principal(env);
    await expect(runScenarios(() => connect(env, a.token))).rejects.toThrow(
      'two distinct accounts',
    );
  });

  it('runs the staging read-only assertion with valid input and no financial writes', async () => {
    const env = bindings();
    const reader = await principal(env, ['expenses:read']);
    const client = await connect(env, reader.token);
    try {
      await runReadOnlyScenario(client);
      expect(await env.DB.prepare('SELECT COUNT(*) n FROM expenses').first('n')).toBe(0);
      expect(await env.DB.prepare('SELECT COUNT(*) n FROM expense_mutations').first('n')).toBe(0);
    } finally {
      await client.close();
    }
  });

  it('fails the staging read-only assertion if the client can write', async () => {
    const env = bindings();
    const writer = await principal(env);
    const client = await connect(env, writer.token);
    try {
      await expect(runReadOnlyScenario(client)).rejects.toThrow('read-only scope');
    } finally {
      await client.close();
    }
  });

  it('keeps staging closed without an allowlist and requires HTTPS', async () => {
    const env = bindings({ APP_ENV: 'staging', APP_ORIGIN: 'https://staging.example' });
    expect(allowedSubject(env, 'arbitrary')).toBe(false);
    for (const path of ['/authorize', '/auth/google/callback', '/oauth/token', '/oauth/register']) {
      const response = await dispatch(new Request(`${env.APP_ORIGIN}${path}`), env);
      expect(response.status).toBe(503);
      expect(response.headers.get('Cache-Control')).toBe('no-store');
    }
    expect(
      (
        await dispatch(new Request('http://localhost:8787/health'), {
          ...env,
          APP_ORIGIN: 'http://localhost:8787',
        })
      ).status,
    ).toBe(503);
    expect(
      allowedSubject({ ...env, ALLOWED_GOOGLE_SUBJECTS: 'subject-a, subject-b' }, 'subject-b'),
    ).toBe(true);
    expect(allowedSubject({ ...env, ALLOWED_GOOGLE_SUBJECTS: ', ,' }, 'arbitrary')).toBe(false);
  });

  it('limits anonymous OAuth before storage and returns retry guidance', async () => {
    const env = bindings({ OAUTH_RATE_LIMIT: { limit: async () => ({ success: false }) } });
    const response = await dispatch(
      new Request(`${env.APP_ORIGIN}/oauth/register`, { method: 'POST', body: '{}' }),
      env,
    );
    expect(response.status).toBe(429);
    expect(response.headers.get('Retry-After')).toBe('60');
    expect(response.headers.get('X-Request-Id')).toMatch(/^[a-f0-9-]{36}$/);
  });

  it('limits verified MCP users and never calls the user limiter for forged credentials', async () => {
    const limit = vi.fn(async ({ key }: { key: string }) => ({ success: key === 'ingress' }));
    const env = bindings({ MCP_RATE_LIMIT: { limit } });
    const a = await principal(env);
    expect(
      (
        await dispatch(
          new Request(`${env.APP_ORIGIN}/mcp`, { headers: { Authorization: 'Bearer forged' } }),
          env,
        )
      ).status,
    ).toBe(401);
    expect(limit).toHaveBeenCalledExactlyOnceWith({ key: 'ingress' });
    const response = await dispatch(
      new Request(`${env.APP_ORIGIN}/mcp`, { headers: { Authorization: `Bearer ${a.token}` } }),
      env,
    );
    expect(response.status).toBe(429);
    expect(limit).toHaveBeenCalledWith({ key: a.userId });
  });

  it('redacts untrusted OAuth error descriptions and correlates safe diagnostics', async () => {
    const log = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const env = bindings();
    const marker = 'SYNTHETIC-SENSITIVE-DO-NOT-LOG';
    const response = await dispatch(
      new Request(`${env.APP_ORIGIN}/oauth/token`, {
        method: 'POST',
        body: new URLSearchParams({ grant_type: marker }),
      }),
      env,
    );
    expect(response.status).toBe(401);
    expect(await response.text()).not.toContain(marker);
    expect(log.mock.calls.flat().join(' ')).not.toContain(marker);
    expect(log).toHaveBeenCalledWith(
      JSON.stringify({ event: 'oauth_rejected', requestId: response.headers.get('X-Request-Id') }),
    );
  });

  it('rejects expired access tokens and wrong resources without relying on client-side expiry', async () => {
    const env = bindings();
    const a = await principal(env);
    const keys = await env.OAUTH_KV.list({ prefix: `token:${a.userId}:` });
    const key = keys.keys[0]?.name;
    expect(key).toBeDefined();
    const token = await env.OAUTH_KV.get<Record<string, unknown>>(key ?? '', 'json');
    expect(token).toBeTruthy();
    await env.OAUTH_KV.put(
      key ?? '',
      JSON.stringify({ ...token, expiresAt: Math.floor(Date.now() / 1000) - 60 }),
    );
    expect(
      (
        await dispatch(
          new Request(`${env.APP_ORIGIN}/mcp`, { headers: { Authorization: `Bearer ${a.token}` } }),
          env,
        )
      ).status,
    ).toBe(401);
    const b = await principal(env);
    const refreshed = await dispatch(
      new Request(`${env.APP_ORIGIN}/oauth/token`, {
        method: 'POST',
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          client_id: b.clientId,
          refresh_token: b.refreshToken ?? '',
          resource: 'https://other.example/mcp',
        }),
      }),
      env,
    );
    expect(refreshed.status).toBe(400);
  });

  it('rejects mismatched redirects, missing public PKCE, plain PKCE and unknown scopes', async () => {
    const env = bindings({ GOOGLE_CLIENT_ID: 'synthetic', GOOGLE_CLIENT_SECRET: 'synthetic' });
    const oauth = getOAuthApi(oauthOptions(env), env);
    const client = await oauth.createClient({
      redirectUris: ['https://client.example/callback'],
      tokenEndpointAuthMethod: 'none',
    });
    for (const changes of [
      { redirect_uri: 'https://evil.example/callback' },
      { code_challenge: '' },
      { code_challenge_method: 'plain' },
      { scope: 'expenses:read admin' },
    ]) {
      const url = new URL(`${env.APP_ORIGIN}/authorize`);
      url.search = new URLSearchParams({
        client_id: client.clientId,
        redirect_uri: 'https://client.example/callback',
        response_type: 'code',
        code_challenge: 'a'.repeat(43),
        code_challenge_method: 'S256',
        scope: 'expenses:read',
        resource: `${env.APP_ORIGIN}/mcp`,
        ...changes,
      }).toString();
      const response = await dispatch(new Request(url), env);
      expect([400, 302]).toContain(response.status);
      if (response.status === 302) {
        const redirect = new URL(response.headers.get('Location') ?? '');
        expect(redirect.origin).toBe('https://client.example');
        expect(redirect.searchParams.has('error')).toBe(true);
      }
    }
  });
});
