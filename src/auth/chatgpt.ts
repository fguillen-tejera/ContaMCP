import type { AuthRequest, OAuthHelpers } from '@cloudflare/workers-oauth-provider';

function isChatGptCallback(uri: string): boolean {
  if (uri === 'https://chatgpt.com/connector_platform_oauth_redirect') return true;
  const prefix = 'https://chatgpt.com/connector/oauth/';
  if (!uri.startsWith(prefix)) return false;
  const callbackId = uri.slice(prefix.length);
  return callbackId.length > 0 && !/[^A-Za-z0-9_-]/.test(callbackId);
}

export async function isChatGptConnection(
  oauth: Pick<OAuthHelpers, 'lookupClient'>,
  request: AuthRequest,
): Promise<boolean> {
  if (!isChatGptCallback(request.redirectUri)) return false;
  const client = await oauth.lookupClient(request.clientId);
  // Preapprove only delivery to ChatGPT. Client names, URLs and request headers are self-asserted.
  return (
    client !== null &&
    client.clientId === request.clientId &&
    client.redirectUris.includes(request.redirectUri) &&
    client.redirectUris.every(isChatGptCallback)
  );
}
