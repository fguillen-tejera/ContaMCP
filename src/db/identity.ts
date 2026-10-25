import { and, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import type { VerifiedIdentity } from '../auth/identity';
import { users } from './schema';

export async function identityOwner(binding: D1Database, identity: VerifiedIdentity) {
  const db = drizzle(binding);
  await db
    .insert(users)
    .values({
      id: crypto.randomUUID(),
      googleSubject: identity.subject,
      authProvider: identity.provider,
      createdAt: new Date().toISOString(),
    })
    .onConflictDoNothing();
  const owner = await db
    .select({ id: users.id })
    .from(users)
    .where(
      and(eq(users.googleSubject, identity.subject), eq(users.authProvider, identity.provider)),
    )
    .get();
  // A legacy global subject uniqueness conflict must deny access, never link providers by email/ID.
  if (!owner) throw new Error('Identity could not be registered.');
  return owner.id;
}
