import { consentPage, validScopeDependencies } from './consent';
import { rememberedConsent } from './approvals';
import { isChatGptConnection } from './chatgpt';
import {
  AuthorizationError,
  CimdFetchError,
  OAuthProvider,
  type OAuthHelpers,
  type AuthRequest,
  type OAuthProviderOptions,
  authorizationErrorRedirect,
  insufficientScope,
} from '@cloudflare/workers-oauth-provider';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import { Hono } from 'hono';
import { z } from 'zod';
import { ledgerStore } from '../db/ledger';
import { users } from '../db/schema';
import type { Diagnostics } from '../diagnostics';
import { handleMcp } from '../mcp/handler';
import {
  type GoogleConfig,
  type GoogleState,
  googleAuthorizationUrl,
  googleSubject,
} from './google';

export type AppEnv = Omit<
  Env,
  'APP_ORIGIN' | 'APP_ENV' | 'GOOGLE_ACCESS_MODE' | 'OPENAI_APPS_CHALLENGE'
> & {
  APP_ORIGIN: string;
  APP_ENV: 'local' | 'staging' | 'production';
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  ALLOWED_GOOGLE_SUBJECTS?: string;
  GOOGLE_ACCESS_MODE?: string;
  OPENAI_APPS_CHALLENGE?: string;
  OAUTH_PROVIDER?: OAuthHelpers;
  DIAGNOSTICS?: Diagnostics;
};
type OAuthEnv = AppEnv & { OAUTH_PROVIDER: OAuthHelpers };
const identitySchema = z.strictObject({ userId: z.uuid(), googleSubject: z.string().min(1) });
const contextSchema = z.object({
  props: identitySchema,
  auth: z.object({
    token: z.string(),
    audience: z.string(),
    scope: z.array(z.string()),
    userId: z.string(),
  }),
});
const scopes = ['expenses:read', 'expenses:write', 'ledger:read', 'ledger:write'];
const consentSubmissionSchema = z.strictObject({
  handle: z.string().min(1).max(128),
  decision: z.enum(['approve', 'deny']),
});

export function allowedSubject(env: AppEnv, subject: string): boolean {
  if (!subject.trim()) return false;
  const mode = googleAccessMode(env);
  if (mode === 'public') return true;
  if (mode !== 'allowlist') return false;
  const allowed = (env.ALLOWED_GOOGLE_SUBJECTS ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  return (env.APP_ENV === 'local' && allowed.length === 0) || allowed.includes(subject);
}

export function googleAccessMode(env: AppEnv): 'allowlist' | 'public' | undefined {
  if (env.GOOGLE_ACCESS_MODE === undefined || env.GOOGLE_ACCESS_MODE === 'allowlist')
    return 'allowlist';
  if (env.GOOGLE_ACCESS_MODE === 'public') return 'public';
}

function googleConfig(env: AppEnv): GoogleConfig | undefined {
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) return;
  return {
    clientId: env.GOOGLE_CLIENT_ID,
    clientSecret: env.GOOGLE_CLIENT_SECRET,
    redirectUri: `${env.APP_ORIGIN}/auth/google/callback`,
  };
}

async function startGoogleSignIn(
  oauth: OAuthHelpers,
  request: AuthRequest,
  config: GoogleConfig,
  headers?: Headers,
) {
  const data: GoogleState = {
    verifier: (crypto.randomUUID() + crypto.randomUUID()).replaceAll('-', ''),
    nonce: crypto.randomUUID(),
  };
  const upstream = await oauth.beginUpstream(request, { data, headers });
  upstream.headers.set('Location', await googleAuthorizationUrl(config, upstream.state, data));
  return new Response(null, { status: 302, headers: upstream.headers });
}

const authRoutes = new Hono<{ Bindings: OAuthEnv }>();
authRoutes.get('/health', (c) => c.json({ status: 'ok', service: 'contamcp' }));
authRoutes.get('/', (c) =>
  c.text('ContaMCP remote MCP endpoint: /mcp. Connect using an OAuth-capable MCP client.'),
);
authRoutes.get('/authorize', async (c) => {
  const config = googleConfig(c.env);
  if (!config) return c.json({ error: 'oauth_not_configured' }, 503);
  const oauth = c.env.OAUTH_PROVIDER;
  const request = await oauth.parseAuthRequest(c.req.raw);
  if (
    request.codeChallengeMethod !== 'S256' ||
    !/^[A-Za-z0-9_-]{43}$/.test(request.codeChallenge ?? '')
  )
    throw new AuthorizationError('invalid_request', { description: 'S256 PKCE is required.' });
  if (request.scope.some((scope) => !scopes.includes(scope)))
    throw new AuthorizationError('invalid_scope', { description: 'Unsupported scope.' });
  if (
    !request.scope.some((scope) => scope.endsWith(':read')) ||
    !validScopeDependencies(request.scope)
  )
    throw new AuthorizationError('invalid_scope', {
      description: 'Request read access or matching read and write access.',
    });
  if (await isChatGptConnection(oauth, request)) return startGoogleSignIn(oauth, request, config);
  const remember = await rememberedConsent(config.clientSecret, c.env.APP_ORIGIN);
  if (await oauth.isConsentRemembered(c.req.raw, request, remember))
    return startGoogleSignIn(oauth, request, config);
  const details = await oauth.describeConsent(request);
  const styleNonce = crypto.randomUUID();
  const consent = await oauth.beginConsent(request);
  consent.headers.set('Content-Type', 'text/html; charset=utf-8');
  consent.headers.set(
    'Content-Security-Policy',
    // Chromium also checks form-action on the approved redirect to Google.
    `default-src 'none'; style-src 'nonce-${styleNonce}'; form-action 'self' https://accounts.google.com; frame-ancestors 'none'; base-uri 'none'`,
  );
  return new Response(
    consentPage(
      details,
      consent.handle,
      styleNonce,
      /^en\b/i.test(c.req.header('Accept-Language') ?? ''),
    ),
    { headers: consent.headers },
  );
});
authRoutes.post('/authorize', async (c) => {
  const config = googleConfig(c.env);
  if (!config) return c.json({ error: 'oauth_not_configured' }, 503);
  const oauth = c.env.OAUTH_PROVIDER;
  const form = await c.req.formData();
  const submission = consentSubmissionSchema.safeParse(Object.fromEntries(form));
  if (!submission.success || [...form.keys()].length !== 2)
    throw new AuthorizationError('invalid_request', {
      description: 'Invalid connection request. Start again from your MCP client.',
    });
  const { handle, decision } = submission.data;
  if (decision === 'deny') {
    const denied = await oauth.denyConsent(c.req.raw, handle);
    return new Response(null, { status: 302, headers: denied.headers });
  }
  // Approve exactly the server-stored request; the form cannot choose or expand scopes.
  const approved = await oauth.approveConsent(c.req.raw, handle, {
    remember: await rememberedConsent(config.clientSecret, c.env.APP_ORIGIN),
  });
  return startGoogleSignIn(oauth, approved.request, config, approved.headers);
});
authRoutes.get('/auth/google/callback', async (c) => {
  const config = googleConfig(c.env);
  if (!config) return c.json({ error: 'oauth_not_configured' }, 503);
  const oauth = c.env.OAUTH_PROVIDER;
  const upstream = await oauth.finishUpstream<GoogleState>(c.req.raw);
  const deny = () => {
    upstream.headers.set('Location', authorizationErrorRedirect(upstream.request, 'access_denied'));
    return new Response(null, { status: 302, headers: upstream.headers });
  };
  const code = c.req.query('code');
  if (!code || c.req.query('error')) return deny();
  let subject: string;
  try {
    subject = await googleSubject(config, code, upstream.data);
  } catch {
    c.env.DIAGNOSTICS?.report('google_verification_failed');
    return deny();
  }
  if (!allowedSubject(c.env, subject)) return deny();
  const db = drizzle(c.env.DB);
  await db
    .insert(users)
    .values({
      id: crypto.randomUUID(),
      googleSubject: subject,
      createdAt: new Date().toISOString(),
    })
    .onConflictDoNothing({ target: users.googleSubject });
  const user = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.googleSubject, subject))
    .get();
  if (!user) throw new Error('User persistence failed.');
  const { redirectTo } = await oauth.completeAuthorization({
    request: upstream.request,
    userId: user.id,
    metadata: {},
    scope: upstream.request.scope,
    props: { userId: user.id, googleSubject: subject },
  });
  upstream.headers.set('Location', redirectTo);
  return new Response(null, { status: 302, headers: upstream.headers });
});
authRoutes.onError((error, c) => {
  if (error instanceof AuthorizationError && error.redirectTo)
    return Response.redirect(error.redirectTo, 302);
  if (error instanceof AuthorizationError || error instanceof CimdFetchError) {
    return Response.json(
      {
        error: 'invalid_authorization',
        message: 'Authorization expired or invalid. Start again from your MCP client.',
      },
      { status: 400 },
    );
  }
  c.env.DIAGNOSTICS?.report('authorization_failed');
  return Response.json({ error: 'internal_error' }, { status: 500 });
});

export function oauthOptions(env: AppEnv): OAuthProviderOptions<AppEnv> {
  return {
    apiRoute: '/mcp',
    authorizeEndpoint: '/authorize',
    tokenEndpoint: '/oauth/token',
    clientRegistrationEndpoint: '/oauth/register',
    // 1.2.4 logs client-supplied CIMD URLs outside onError. DCR avoids that leak.
    clientIdMetadataDocumentEnabled: false,
    onError: ({ code, status, headers }) => {
      env.DIAGNOSTICS?.report('oauth_rejected');
      return Response.json({ error: code }, { status, headers });
    },
    accessTokenTTL: 900,
    refreshTokenTTL: 604_800,
    scopesSupported: scopes,
    // The combined provider uses this for discovery/challenges; handlers enforce each operation.
    requiredScopes: scopes,
    resourceMetadata: {
      resource: `${env.APP_ORIGIN}/mcp`,
      authorization_servers: [env.APP_ORIGIN],
    },
    defaultHandler: {
      fetch: (request, bindings, ctx) => {
        if (!bindings.OAUTH_PROVIDER)
          return new Response('Authorization unavailable', { status: 503 });
        return authRoutes.fetch(
          request,
          { ...bindings, OAUTH_PROVIDER: bindings.OAUTH_PROVIDER },
          ctx,
        );
      },
    },
    apiHandler: {
      async fetch(request, bindings, ctx) {
        if (new URL(request.url).pathname !== '/mcp')
          return new Response('Not found', { status: 404 });
        const verified = contextSchema.safeParse(ctx);
        if (
          !verified.success ||
          verified.data.auth.userId !== verified.data.props.userId ||
          !allowedSubject(bindings, verified.data.props.googleSubject)
        ) {
          return Response.json({ error: 'invalid_identity' }, { status: 403 });
        }
        const { props, auth } = verified.data;
        if (!auth.scope.includes('expenses:read') && !auth.scope.includes('ledger:read'))
          return insufficientScope(auth, ['expenses:read']);
        if (!(await bindings.MCP_RATE_LIMIT.limit({ key: props.userId })).success)
          return Response.json(
            { error: 'rate_limited' },
            { status: 429, headers: { 'Retry-After': '60' } },
          );
        return handleMcp(
          request,
          ledgerStore(bindings.DB),
          {
            userId: props.userId,
            scopes: auth.scope,
            resourceMetadata: `${bindings.APP_ORIGIN}/.well-known/oauth-protected-resource/mcp`,
          },
          bindings.DIAGNOSTICS,
        );
      },
    },
  };
}

export function oauthProvider(env: AppEnv) {
  return new OAuthProvider(oauthOptions(env));
}
