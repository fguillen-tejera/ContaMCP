import { automaticRecordingOwners } from './db/automatic';
import { ledgerStore } from './db/ledger';
import { recordDueOccurrences } from './planning/automatic';
import { type AppEnv, oauthProvider } from './auth/provider';
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

async function handleRequest(request: Request, env: AppEnv, ctx: ExecutionContext) {
  const origin = new URL(env.APP_ORIGIN);
  if (
    !['local', 'staging'].includes(env.APP_ENV) ||
    origin.origin !== env.APP_ORIGIN ||
    (origin.protocol !== 'https:' &&
      !(env.APP_ENV === 'local' && origin.protocol === 'http:' && origin.hostname === 'localhost'))
  )
    return Response.json({ error: 'invalid_server_origin' }, { status: 503 });
  const url = new URL(request.url);
  if (url.origin !== origin.origin)
    return Response.json({ error: 'unexpected_host' }, { status: 421 });
  const browserOrigin = request.headers.get('Origin');
  if (browserOrigin && browserOrigin !== origin.origin)
    return Response.json({ error: 'untrusted_origin' }, { status: 403 });
  if (url.pathname === '/mcp' && !(await env.MCP_RATE_LIMIT.limit({ key: 'ingress' })).success)
    return Response.json(
      { error: 'rate_limited' },
      { status: 429, headers: { 'Retry-After': '60' } },
    );
  if (
    env.APP_ENV === 'staging' &&
    ['/authorize', '/auth/google/callback', '/oauth/token', '/oauth/register'].includes(
      url.pathname,
    )
  ) {
    if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET || !env.ALLOWED_GOOGLE_SUBJECTS?.trim())
      return Response.json({ error: 'staging_not_configured' }, { status: 503 });
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
          if (
            !['local', 'staging'].includes(env.APP_ENV) ||
            (env.APP_ENV === 'staging' && (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET))
          )
            throw new Error('Automatic recording is not configured.');
          const subjects = (env.ALLOWED_GOOGLE_SUBJECTS ?? '')
            .split(',')
            .map((subject) => subject.trim())
            .filter(Boolean);
          const owners = await automaticRecordingOwners(env.DB, subjects);
          const result = await recordDueOccurrences(
            ledgerStore(env.DB),
            owners,
            new Date(controller.scheduledTime),
          );
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
      request.method === 'GET' && new URL(request.url).pathname === '/authorize';
    secured.headers.set('Referrer-Policy', isConsentPage ? 'strict-origin' : 'no-referrer');
    secured.headers.set('X-Content-Type-Options', 'nosniff');
    secured.headers.set('X-Request-Id', diagnostic.requestId);
    return secured;
  },
} satisfies ExportedHandler<AppEnv>;
