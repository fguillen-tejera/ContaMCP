import {
  createExecutionContext,
  createScheduledController,
  waitOnExecutionContext,
} from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runReadOnlyScenario, runScenarios } from '../scripts/mcp-scenarios';
import { type AppEnv, allowedSubject } from '../src/auth/provider';
import { ledgerStore } from '../src/db/ledger';
import worker from '../src/index';
import { createRecurring } from '../src/planning/recurring';
import { bindings, connect, dispatch, principal } from './helpers';

function production(overrides: Partial<AppEnv> = {}) {
  return bindings({
    APP_ENV: 'production',
    APP_ORIGIN: 'https://production.example',
    GOOGLE_CLIENT_ID: 'synthetic-client',
    GOOGLE_CLIENT_SECRET: 'synthetic-secret',
    ALLOWED_GOOGLE_SUBJECTS: 'synthetic-subject',
    ...overrides,
  });
}

afterEach(() => vi.restoreAllMocks());

describe('production boundaries', () => {
  it('serves only the exact configured public directory challenge without requiring a login', async () => {
    const challenge = 'synthetic-directory-challenge_1234567890';
    const env = production({
      OPENAI_APPS_CHALLENGE: challenge,
      GOOGLE_CLIENT_ID: undefined,
      GOOGLE_CLIENT_SECRET: undefined,
    });
    const oauthLimit = vi.spyOn(env.OAUTH_RATE_LIMIT, 'limit');
    const database = vi.spyOn(env.DB, 'prepare');
    for (const method of ['GET', 'HEAD']) {
      const response = await dispatch(
        new Request(`${env.APP_ORIGIN}/.well-known/openai-apps-challenge`, { method }),
        env,
      );
      expect(response.status).toBe(200);
      expect(await response.text()).toBe(method === 'HEAD' ? '' : challenge);
      expect(response.headers.get('Content-Type')).toBe('text/plain; charset=utf-8');
      expect(response.headers.get('Cache-Control')).toBe('no-store');
      expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
    }
    expect(oauthLimit).not.toHaveBeenCalled();
    expect(database).not.toHaveBeenCalled();
  });

  it.each([
    { OPENAI_APPS_CHALLENGE: undefined },
    { OPENAI_APPS_CHALLENGE: '' },
    { OPENAI_APPS_CHALLENGE: 'short' },
    { OPENAI_APPS_CHALLENGE: `${'a'.repeat(32)}\n` },
    { OPENAI_APPS_CHALLENGE: 'a'.repeat(257) },
    { APP_ENV: 'staging' as const, OPENAI_APPS_CHALLENGE: 'a'.repeat(32) },
    { APP_ENV: 'local' as const, OPENAI_APPS_CHALLENGE: 'a'.repeat(32) },
  ])('does not publish an absent, malformed or non-production challenge: %j', async (overrides) => {
    const env = production(overrides);
    const response = await dispatch(
      new Request(`${env.APP_ORIGIN}/.well-known/openai-apps-challenge?token=${'b'.repeat(32)}`),
      env,
    );
    expect(response.status).toBe(404);
    expect(await response.text()).toBe('');
  });

  it('preserves canonical-host, browser-origin and MCP authentication boundaries around the challenge', async () => {
    const env = production({ OPENAI_APPS_CHALLENGE: 'a'.repeat(32) });
    const path = '/.well-known/openai-apps-challenge';
    expect((await dispatch(new Request(`https://alternate.example${path}`), env)).status).toBe(421);
    expect(
      (
        await dispatch(
          new Request(`${env.APP_ORIGIN}${path}`, {
            headers: { Origin: 'https://untrusted.example' },
          }),
          env,
        )
      ).status,
    ).toBe(403);
    const post = await dispatch(new Request(`${env.APP_ORIGIN}${path}`, { method: 'POST' }), env);
    expect(post.status).toBe(405);
    expect(post.headers.get('Allow')).toBe('GET, HEAD');
    expect((await dispatch(new Request(`${env.APP_ORIGIN}/mcp`), env)).status).toBe(401);
  });

  it.each([
    { GOOGLE_CLIENT_ID: undefined },
    { GOOGLE_CLIENT_SECRET: undefined },
    { ALLOWED_GOOGLE_SUBJECTS: undefined },
    { GOOGLE_CLIENT_ID: ' ' },
    { GOOGLE_CLIENT_SECRET: ' ' },
    { ALLOWED_GOOGLE_SUBJECTS: ', ,' },
    { GOOGLE_ACCESS_MODE: 'public', GOOGLE_CLIENT_ID: undefined },
    { GOOGLE_ACCESS_MODE: 'public', GOOGLE_CLIENT_SECRET: ' ' },
    { GOOGLE_ACCESS_MODE: '' },
    { GOOGLE_ACCESS_MODE: 'PUBLIC' },
    { GOOGLE_ACCESS_MODE: 'unknown' },
  ])('closes OAuth entry points when configuration is incomplete: %j', async (overrides) => {
    const env = production(overrides);
    const limit = vi.spyOn(env.OAUTH_RATE_LIMIT, 'limit');
    for (const path of ['/authorize', '/auth/google/callback', '/oauth/token', '/oauth/register']) {
      const response = await dispatch(new Request(`${env.APP_ORIGIN}${path}`), env);
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ error: 'production_not_configured' });
      expect(response.headers.get('Cache-Control')).toBe('no-store');
    }
    expect(limit).not.toHaveBeenCalled();
  });

  it.each([
    'http://localhost:8787',
    'http://production.example',
    'https://production.example/',
    'https://production.example/path',
    'https://production.example?query=value',
    'https://user:password@production.example',
    'not a URL',
  ])('rejects invalid production origins before authentication: %s', async (origin) => {
    const response = await dispatch(
      new Request('https://production.example/health'),
      production({ APP_ORIGIN: origin }),
    );
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'invalid_server_origin' });
  });

  it('serves the canonical HTTPS origin and rejects alternate hosts and browser origins', async () => {
    const env = production();
    expect((await dispatch(new Request(`${env.APP_ORIGIN}/health`), env)).status).toBe(200);
    const discovery = await dispatch(
      new Request(`${env.APP_ORIGIN}/.well-known/oauth-authorization-server`),
      env,
    );
    expect(discovery.status).toBe(200);
    expect(await discovery.json()).toMatchObject({
      issuer: env.APP_ORIGIN,
      authorization_endpoint: `${env.APP_ORIGIN}/authorize`,
      token_endpoint: `${env.APP_ORIGIN}/oauth/token`,
    });
    expect((await dispatch(new Request('https://alternate.example/health'), env)).status).toBe(421);
    for (const origin of ['https://untrusted.example', 'null']) {
      expect(
        (
          await dispatch(
            new Request(`${env.APP_ORIGIN}/health`, { headers: { Origin: origin } }),
            env,
          )
        ).status,
      ).toBe(403);
    }
    expect(
      (
        await dispatch(
          new Request(`${env.APP_ORIGIN}/mcp`, {
            headers: { Authorization: 'Bearer forged', 'X-User-Id': crypto.randomUUID() },
          }),
          env,
        )
      ).status,
    ).toBe(401);
  });

  it('preserves owner isolation, read-only grants and removal of an already authenticated subject', async () => {
    const env = production();
    const a = await principal(env);
    const b = await principal(env);
    env.ALLOWED_GOOGLE_SUBJECTS = `${a.subject}, ${b.subject}`;
    expect(allowedSubject(env, 'unlisted-subject')).toBe(false);
    expect(allowedSubject({ ...env, ALLOWED_GOOGLE_SUBJECTS: '' }, a.subject)).toBe(false);
    expect(
      await runScenarios((account) => connect(env, account === 'A' ? a.token : b.token)),
    ).toEqual({ scenarios: 12, syntheticRecordsCreated: 2 });
    const reader = await principal(env, ['expenses:read'], a);
    const client = await connect(env, reader.token);
    try {
      await runReadOnlyScenario(client);
    } finally {
      await client.close();
    }
    env.ALLOWED_GOOGLE_SUBJECTS = b.subject;
    expect(
      (
        await dispatch(
          new Request(`${env.APP_ORIGIN}/mcp`, { headers: { Authorization: `Bearer ${a.token}` } }),
          env,
        )
      ).status,
    ).toBe(403);
    expect(await env.DB.prepare('SELECT COUNT(*) n FROM expenses').first('n')).toBe(2);
    expect(await env.DB.prepare('SELECT COUNT(*) n FROM expense_mutations').first('n')).toBe(3);
  });

  it('opens signup explicitly while preserving private ledgers and scope checks', async () => {
    const env = production({ GOOGLE_ACCESS_MODE: 'public', ALLOWED_GOOGLE_SUBJECTS: undefined });
    const a = await principal(env);
    const b = await principal(env);
    expect(allowedSubject(env, a.subject)).toBe(true);
    expect(allowedSubject(env, '')).toBe(false);
    expect(allowedSubject({ ...env, GOOGLE_ACCESS_MODE: 'unknown' }, a.subject)).toBe(false);
    expect(
      await runScenarios((account) => connect(env, account === 'A' ? a.token : b.token)),
    ).toEqual({ scenarios: 12, syntheticRecordsCreated: 2 });
    const reader = await principal(env, ['expenses:read'], a);
    const client = await connect(env, reader.token);
    try {
      await runReadOnlyScenario(client);
    } finally {
      await client.close();
    }
    for (const mode of ['allowlist', 'unknown']) {
      expect(
        (
          await dispatch(
            new Request(`${env.APP_ORIGIN}/mcp`, {
              headers: { Authorization: `Bearer ${a.token}` },
            }),
            { ...env, GOOGLE_ACCESS_MODE: mode },
          )
        ).status,
      ).toBe(403);
    }
    expect((await dispatch(new Request(`${env.APP_ORIGIN}/mcp`), env)).status).toBe(401);
  });

  it('requires new-origin authorization after a hostname change without replacing the user', async () => {
    const previous = production({
      APP_ORIGIN: 'https://previous.example',
      GOOGLE_ACCESS_MODE: 'public',
      ALLOWED_GOOGLE_SUBJECTS: undefined,
    });
    const user = await principal(previous);
    const current = { ...previous, APP_ORIGIN: 'https://production.example' };
    const rejected = await dispatch(
      new Request(`${current.APP_ORIGIN}/mcp`, {
        headers: { Authorization: `Bearer ${user.token}` },
      }),
      current,
    );
    expect(rejected.status).toBe(401);
    expect(rejected.headers.get('WWW-Authenticate')).toContain(
      `${current.APP_ORIGIN}/.well-known/oauth-protected-resource/mcp`,
    );
    expect((await dispatch(new Request(`${previous.APP_ORIGIN}/mcp`), current)).status).toBe(421);
    const reconnected = await principal(current, ['expenses:read'], user);
    const client = await connect(current, reconnected.token);
    try {
      expect((await client.listTools()).tools.length).toBeGreaterThan(0);
    } finally {
      await client.close();
    }
    expect(reconnected.userId).toBe(user.userId);
    expect(await current.DB.prepare('SELECT COUNT(*) n FROM users').first('n')).toBe(1);
  });

  it('processes public users standing schedules within the existing five-occurrence budget', async () => {
    const env = production({ GOOGLE_ACCESS_MODE: 'public', ALLOWED_GOOGLE_SUBJECTS: undefined });
    const store = ledgerStore(env.DB);
    const now = new Date('2026-10-24T06:05:00Z');
    const due = [];
    for (let i = 0; i < 7; i++) {
      const user = await principal(env);
      const schedule = await createRecurring(
        store,
        user.userId,
        {
          description: `SYNTHETIC public schedule ${i}`,
          type: 'expense',
          amount: '0.19',
          currency: 'EUR',
          category: 'other',
          interval: 'monthly',
          firstDate: '2026-10-24',
          idempotencyKey: crypto.randomUUID(),
        },
        now,
      );
      due.push({ user, schedule });
    }
    const ctx = createExecutionContext();
    worker.scheduled(createScheduledController({ scheduledTime: now }), env, ctx);
    await waitOnExecutionContext(ctx);
    expect(await env.DB.prepare('SELECT COUNT(*) n FROM expenses').first('n')).toBe(5);
    const retry = createExecutionContext();
    worker.scheduled(createScheduledController({ scheduledTime: now }), env, retry);
    await waitOnExecutionContext(retry);
    expect(await env.DB.prepare('SELECT COUNT(*) n FROM expenses').first('n')).toBe(7);
    expect(await env.DB.prepare('SELECT COUNT(*) n FROM expense_mutations').first('n')).toBe(7);
    for (const { user, schedule } of due) {
      expect(await store.findOccurrence(user.userId, schedule.id, schedule.nextDate)).toMatchObject(
        {
          amount: '0.19',
          paymentStatus: 'unverified',
          source: 'recurring',
        },
      );
      expect(await store.findRecurring(user.userId, schedule.id)).toMatchObject({ version: 2 });
    }
  });

  it('fails scheduled recording closed and records only allowlisted owners once after configuration', async () => {
    const env = production();
    const a = await principal(env);
    const b = await principal(env);
    env.ALLOWED_GOOGLE_SUBJECTS = a.subject;
    const store = ledgerStore(env.DB);
    const now = new Date('2026-10-24T06:05:00Z');
    const input = {
      description: 'SYNTHETIC production schedule',
      type: 'expense' as const,
      amount: '10.50',
      currency: 'MXN' as const,
      category: 'other' as const,
      interval: 'monthly' as const,
      firstDate: '2026-10-24',
    };
    const first = await createRecurring(
      store,
      a.userId,
      { ...input, idempotencyKey: crypto.randomUUID() },
      now,
    );
    const other = await createRecurring(
      store,
      b.userId,
      { ...input, idempotencyKey: crypto.randomUUID() },
      now,
    );
    async function scheduled(config: AppEnv) {
      const ctx = createExecutionContext();
      worker.scheduled(createScheduledController({ scheduledTime: now }), config, ctx);
      await waitOnExecutionContext(ctx);
    }
    const log = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const invalid: Partial<AppEnv>[] = [
      { GOOGLE_ACCESS_MODE: 'unknown' },
      { GOOGLE_ACCESS_MODE: 'public', GOOGLE_CLIENT_SECRET: undefined },
      { GOOGLE_CLIENT_ID: undefined },
      { GOOGLE_CLIENT_SECRET: ' ' },
      { ALLOWED_GOOGLE_SUBJECTS: '' },
      { ALLOWED_GOOGLE_SUBJECTS: ', ,' },
      {
        ALLOWED_GOOGLE_SUBJECTS: Array.from({ length: 101 }, (_, i) => `synthetic-${i}`).join(','),
      },
      { APP_ORIGIN: 'http://localhost:8787' },
      { APP_ORIGIN: 'not a URL' },
    ];
    for (const overrides of invalid) {
      await expect(scheduled({ ...env, ...overrides })).rejects.toThrow(
        'Automatic recurring recording failed.',
      );
      expect(await env.DB.prepare('SELECT COUNT(*) n FROM expenses').first('n')).toBe(0);
      expect(await env.DB.prepare('SELECT COUNT(*) n FROM expense_mutations').first('n')).toBe(0);
    }
    expect(log).toHaveBeenCalledWith(expect.stringContaining('automatic_recording_failed'));
    expect(log.mock.calls.flat().join(' ')).not.toContain(input.description);
    expect(log.mock.calls.flat().join(' ')).not.toContain(a.subject);
    await scheduled(env);
    await scheduled(env);
    expect(await store.findOccurrence(a.userId, first.id, first.nextDate)).toBeDefined();
    expect(await store.findOccurrence(b.userId, other.id, other.nextDate)).toBeUndefined();
    expect(await env.DB.prepare('SELECT COUNT(*) n FROM expenses').first('n')).toBe(1);
    expect(await env.DB.prepare('SELECT COUNT(*) n FROM expense_mutations').first('n')).toBe(1);
  });
});
