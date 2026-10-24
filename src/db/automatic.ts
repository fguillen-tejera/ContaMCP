import { inArray } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import { users } from './schema';

// The private subject allowlist is the scheduled job's explicit owner scope.
export async function automaticRecordingOwners(binding: D1Database, subjects: readonly string[]) {
  const allowed = [...new Set(subjects.filter((subject) => subject.length > 0))];
  if (allowed.length === 0 || allowed.length > 100)
    throw new Error('Automatic recording requires an explicit bounded owner allowlist.');
  const owners = await drizzle(binding)
    .select({ id: users.id })
    .from(users)
    .where(inArray(users.googleSubject, allowed))
    .orderBy(users.id);
  return owners.map((owner) => owner.id);
}
