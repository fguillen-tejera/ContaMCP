import { z } from 'zod';

export const verifiedIdentitySchema = z.strictObject({
  provider: z.enum(['google', 'firebase']),
  subject: z.string().min(1).max(255),
});
export type VerifiedIdentity = z.infer<typeof verifiedIdentitySchema>;

export const grantIdentitySchema = z.union([
  verifiedIdentitySchema.extend({ userId: z.uuid() }),
  // Existing grants and refresh tokens keep their Google identity through this additive change.
  z
    .strictObject({ userId: z.uuid(), googleSubject: z.string().min(1).max(255) })
    .transform(({ userId, googleSubject }) => ({
      userId,
      provider: 'google' as const,
      subject: googleSubject,
    })),
]);
