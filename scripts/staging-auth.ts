import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { writeFile, unlink } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import {
  auth,
  type OAuthClientProvider,
  type OAuthDiscoveryState,
  type StoredOAuthClientInformation,
  type StoredOAuthTokens,
} from '@modelcontextprotocol/client';
import { z } from 'zod';

export async function stagingLogin(
  endpoint: URL,
  label: string,
  scope = 'expenses:read expenses:write',
  request: typeof fetch = fetch,
) {
  console.log(
    `Authenticate ${label} in the browser. Check the selected Google account and consent scopes.`,
  );
  const state = crypto.randomUUID();
  let resolveCallback: (url: URL) => void = () => {};
  const callback = new Promise<URL>((resolve) => {
    resolveCallback = resolve;
  });
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Referrer-Policy', 'no-referrer');
    if (
      request.method !== 'GET' ||
      url.pathname !== '/callback' ||
      url.searchParams.get('state') !== state
    ) {
      response.writeHead(400).end('Invalid callback.');
      return;
    }
    response.end('Callback received. Return to the terminal.');
    resolveCallback(url);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Callback listener failed.');
  let clientInfo: StoredOAuthClientInformation | undefined;
  let tokens: StoredOAuthTokens | undefined;
  let verifier = '';
  let discovery: OAuthDiscoveryState | undefined;
  const provider: OAuthClientProvider = {
    redirectUrl: `http://127.0.0.1:${address.port}/callback`,
    clientMetadata: {
      redirect_uris: [`http://127.0.0.1:${address.port}/callback`],
      client_name: 'ContaMCP staging verification',
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
    },
    state: () => state,
    clientInformation: () => clientInfo,
    saveClientInformation: (value) => {
      clientInfo = value;
    },
    tokens: () => tokens,
    saveTokens: (value) => {
      tokens = value;
    },
    saveCodeVerifier: (value) => {
      verifier = value;
    },
    codeVerifier: () => verifier,
    discoveryState: () => discovery,
    saveDiscoveryState: (value) => {
      discovery = value;
    },
    redirectToAuthorization: async (url) => {
      // Optional private handoff for the shared browser; never persist issued credentials.
      if (process.env.CONTAMCP_OAUTH_URL_FILE) {
        await writeFile(process.env.CONTAMCP_OAUTH_URL_FILE, url.href, { mode: 0o600 });
        return;
      }
      const command =
        process.platform === 'darwin'
          ? 'open'
          : process.platform === 'win32'
            ? 'rundll32'
            : 'xdg-open';
      const openArgs =
        process.platform === 'win32' ? ['url.dll,FileProtocolHandler', url.href] : [url.href];
      await new Promise<void>((resolve, reject) => {
        const child = spawn(command, openArgs, { stdio: 'ignore' });
        child.once('error', reject);
        child.once('exit', (code) =>
          code === 0 ? resolve() : reject(new Error('Browser launch failed.')),
        );
      });
    },
  };
  const abort = new AbortController();
  try {
    if ((await auth(provider, { serverUrl: endpoint, scope, fetchFn: request })) !== 'REDIRECT')
      throw new Error('Expected interactive OAuth.');
    const url = await Promise.race([
      callback,
      delay(300_000, undefined, { signal: abort.signal }).then(() => {
        throw new Error('Browser login timed out.');
      }),
    ]);
    if (url.searchParams.has('error') || !url.searchParams.get('code'))
      throw new Error('Authorization denied.');
    if (
      (await auth(provider, {
        serverUrl: endpoint,
        scope,
        fetchFn: request,
        authorizationCode: url.searchParams.get('code') ?? '',
        iss: url.searchParams.get('iss') ?? undefined,
      })) !== 'AUTHORIZED'
    )
      throw new Error('Token exchange failed.');
    const issued = z
      .object({
        access_token: z.string(),
        refresh_token: z.string(),
        expires_in: z.number().positive(),
      })
      .parse(tokens);
    if (!clientInfo) throw new Error('Missing registered client.');
    return { ...issued, clientId: clientInfo.client_id, issuedAt: Date.now() };
  } finally {
    if (process.env.CONTAMCP_OAUTH_URL_FILE)
      await unlink(process.env.CONTAMCP_OAUTH_URL_FILE).catch(() => {});
    abort.abort();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}
