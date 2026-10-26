import { automaticRecordingOwners, publicAutomaticRecordingOwners } from './db/automatic';
import { ledgerStore } from './db/ledger';
import { recordDueOccurrences } from './planning/automatic';
import { type AppEnv, googleAccessMode, oauthProvider } from './auth/provider';
import { diagnostics } from './diagnostics';

async function boundedRequest(request: Request): Promise<Request | undefined> {
  if (!request.body) return request;
  const reader = request.body.getReader();
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > 16_384) {
      await reader.cancel();
      return;
    }
    chunks.push(value);
  }
  return new Request(request, { body: new Blob(chunks) });
}

function serverOrigin(env: AppEnv): URL | undefined {
  let origin: URL;
  try {
    origin = new URL(env.APP_ORIGIN);
  } catch {
    return;
  }
  if (
    !['local', 'staging', 'production'].includes(env.APP_ENV) ||
    origin.origin !== env.APP_ORIGIN ||
    (origin.protocol !== 'https:' &&
      !(env.APP_ENV === 'local' && origin.protocol === 'http:' && origin.hostname === 'localhost'))
  )
    return;
  return origin;
}

function hostedAuthConfigured(env: AppEnv): boolean {
  const mode = googleAccessMode(env);
  return Boolean(
    env.GOOGLE_CLIENT_ID?.trim() &&
      env.GOOGLE_CLIENT_SECRET?.trim() &&
      (mode === 'public' ||
        (mode === 'allowlist' &&
          env.ALLOWED_GOOGLE_SUBJECTS?.split(',').some((subject) => subject.trim()))),
  );
}

async function handleRequest(request: Request, env: AppEnv, ctx: ExecutionContext) {
  const origin = serverOrigin(env);
  if (!origin) return Response.json({ error: 'invalid_server_origin' }, { status: 503 });
  const url = new URL(request.url);
  if (url.origin !== origin.origin)
    return Response.json({ error: 'unexpected_host' }, { status: 421 });
  const browserOrigin = request.headers.get('Origin');
  if (browserOrigin && browserOrigin !== origin.origin)
    return Response.json({ error: 'untrusted_origin' }, { status: 403 });
  if (url.pathname === '/.well-known/openai-apps-challenge') {
    if (request.method !== 'GET' && request.method !== 'HEAD')
      return new Response(null, { status: 405, headers: { Allow: 'GET, HEAD' } });
    const challenge = env.OPENAI_APPS_CHALLENGE;
    if (
      env.APP_ENV !== 'production' ||
      !challenge ||
      challenge.length < 32 ||
      challenge.length > 256 ||
      /[^A-Za-z0-9_-]/.test(challenge)
    )
      return new Response(null, { status: 404 });
    // The directory requires the exact public token, without JSON encoding or a newline.
    return new Response(request.method === 'HEAD' ? null : challenge, {
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    });
  }
  if (url.pathname === '/mcp' && !(await env.MCP_RATE_LIMIT.limit({ key: 'ingress' })).success)
    return Response.json(
      { error: 'rate_limited' },
      { status: 429, headers: { 'Retry-After': '60' } },
    );
  if (
    env.APP_ENV !== 'local' &&
    ['/authorize', '/auth/google/callback', '/oauth/token', '/oauth/register'].includes(
      url.pathname,
    )
  ) {
    if (!hostedAuthConfigured(env))
      return Response.json({ error: `${env.APP_ENV}_not_configured` }, { status: 503 });
  }
  if (
    url.pathname === '/authorize' ||
    url.pathname === '/auth/google/callback' ||
    url.pathname.startsWith('/oauth/')
  ) {
    // An aggregate limit also bounds anonymous registration across changing client IDs/IPs.
    if (!(await env.OAUTH_RATE_LIMIT.limit({ key: 'oauth' })).success)
      return Response.json(
        { error: 'rate_limited' },
        { status: 429, headers: { 'Retry-After': '60' } },
      );
  }
  const bounded = await boundedRequest(request);
  if (!bounded) return Response.json({ error: 'request_too_large' }, { status: 413 });
  return oauthProvider(env).fetch(bounded, env, ctx);
}

export default {
  scheduled(controller, env, ctx) {
    ctx.waitUntil(
      (async () => {
        try {
          if (!serverOrigin(env) || (env.APP_ENV !== 'local' && !hostedAuthConfigured(env)))
            throw new Error('Automatic recording is not configured.');
          const subjects = (env.ALLOWED_GOOGLE_SUBJECTS ?? '')
            .split(',')
            .map((subject) => subject.trim())
            .filter(Boolean);
          const now = new Date(controller.scheduledTime);
          const owners =
            googleAccessMode(env) === 'public'
              ? await publicAutomaticRecordingOwners(env.DB, now)
              : await automaticRecordingOwners(env.DB, subjects);
          const result = await recordDueOccurrences(ledgerStore(env.DB), owners, now);
          if (result.failed) throw new Error('Automatic recording failed.');
        } catch {
          diagnostics().report('automatic_recording_failed');
          throw new Error('Automatic recurring recording failed.');
        }
      })(),
    );
  },
  async fetch(request: Request, env: AppEnv, ctx: ExecutionContext) {
    const diagnostic = diagnostics();
    let response: Response;
    try {
      response = await handleRequest(request, { ...env, DIAGNOSTICS: diagnostic }, ctx);
    } catch {
      diagnostic.report('request_failed');
      response = Response.json({ error: 'internal_error' }, { status: 500 });
    }
    const secured = new Response(response.body, response);
    secured.headers.set('Cache-Control', 'no-store');
    // no-referrer makes native form POSTs send Origin: null, blocking consent.
    const isConsentPage =
      new URL(request.url).pathname === '/authorize' &&
      response.headers.get('Content-Type')?.startsWith('text/html');
    secured.headers.set('Referrer-Policy', isConsentPage ? 'strict-origin' : 'no-referrer');
    secured.headers.set('X-Content-Type-Options', 'nosniff');
    secured.headers.set('X-Request-Id', diagnostic.requestId);
    return secured;
  },
} satisfies ExportedHandler<AppEnv>;
