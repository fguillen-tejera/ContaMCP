import { createRemoteJWKSet, jwtVerify } from 'jose';
import { z } from 'zod';
import type { VerifiedIdentity } from './identity';

const firebaseKeys = createRemoteJWKSet(
  new URL(
    'https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com',
  ),
);

const uidSchema = z.string().min(1).max(128);
export const emailCredentialsSchema = z.strictObject({
  email: z.email().max(320),
  password: z.string().min(1).max(4096),
});
const configSchema = z.strictObject({
  projectId: z.string().regex(/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/),
  apiKey: z.string().min(1).max(256).regex(/^\S+$/),
  allowedUids: z.array(uidSchema).min(1).max(100),
});
export type FirebaseConfig = z.infer<typeof configSchema>;

export function firebaseConfig(env: {
  FIREBASE_PROJECT_ID?: string;
  FIREBASE_WEB_API_KEY?: string;
  FIREBASE_ALLOWED_UIDS?: string;
}): FirebaseConfig | undefined {
  const parsed = configSchema.safeParse({
    projectId: env.FIREBASE_PROJECT_ID,
    apiKey: env.FIREBASE_WEB_API_KEY,
    allowedUids: env.FIREBASE_ALLOWED_UIDS?.split(',')
      .map((uid) => uid.trim())
      .filter(Boolean),
  });
  return parsed.success ? parsed.data : undefined;
}

export async function firebaseIdentity(
  config: FirebaseConfig,
  credentials: z.infer<typeof emailCredentialsSchema>,
): Promise<VerifiedIdentity> {
  const url = new URL('https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword');
  url.searchParams.set('key', config.apiKey);
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...credentials, returnSecureToken: true }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error('Email sign-in failed.');
  const result = z
    .object({ idToken: z.string().min(1).max(16_384), localId: uidSchema })
    .parse(await response.json());
  const { payload } = await jwtVerify(result.idToken, firebaseKeys, {
    issuer: `https://securetoken.google.com/${config.projectId}`,
    audience: config.projectId,
    algorithms: ['RS256'],
    maxTokenAge: '5 minutes',
    clockTolerance: 5,
    requiredClaims: ['sub', 'iat', 'exp', 'auth_time'],
  });
  const identity = z
    .object({
      sub: uidSchema,
      aud: z.literal(config.projectId),
      auth_time: z.number().int().nonnegative(),
      firebase: z.object({ sign_in_provider: z.literal('password') }),
    })
    .parse(payload);
  if (
    identity.sub !== result.localId ||
    identity.auth_time > Math.floor(Date.now() / 1000) + 5 ||
    !config.allowedUids.includes(identity.sub)
  )
    throw new Error('Email sign-in failed.');
  // Upstream tokens and email addresses are not persisted or returned to MCP clients.
  return { provider: 'firebase', subject: identity.sub };
}
