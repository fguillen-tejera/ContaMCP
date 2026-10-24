import type { RememberConsentOptions } from '@cloudflare/workers-oauth-provider';

export const CONSENT_REMEMBER_DAYS = 30;

export async function rememberedConsent(
  secret: string,
  origin: string,
): Promise<RememberConsentOptions> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), 'HKDF', false, [
    'deriveBits',
  ]);
  // A separate signing key per origin and purpose; rotating Google credentials invalidates approvals.
  const derived = await crypto.subtle.deriveBits(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: encoder.encode(origin),
      info: encoder.encode('contamcp/remembered-consent/v1'),
    },
    key,
    256,
  );
  return {
    secret: Array.from(new Uint8Array(derived), (byte) => byte.toString(16).padStart(2, '0')).join(
      '',
    ),
    maxAgeSeconds: CONSENT_REMEMBER_DAYS * 86_400,
  };
}
