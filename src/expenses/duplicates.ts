import { LedgerError, type Expense } from '../domain/expense';

export type DuplicateProbe = Pick<
  Expense,
  'description' | 'amountMinor' | 'currency' | 'date' | 'type'
>;
export type DuplicateAcknowledgement = { id: string; version: number };

export function duplicateTokens(description: string): string[] {
  const stop = new Set([
    'del',
    'los',
    'las',
    'por',
    'para',
    'con',
    'una',
    'the',
    'for',
    'pago',
    'gasto',
    'ingreso',
    'payment',
  ]);
  return [
    ...new Set(
      description
        .normalize('NFD')
        .replace(/\p{M}/gu, '')
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((token) => token.length >= 3 && !stop.has(token)),
    ),
  ].slice(0, 12);
}

export function requireDuplicateConfirmation(
  candidates: Expense[],
  acknowledged: DuplicateAcknowledgement[] = [],
) {
  if (candidates.length > 20)
    throw new LedgerError(
      'INVALID_INPUT',
      'Too many possible duplicates. Review existing entries before recording this intent.',
    );
  if (
    candidates.some(
      (candidate) =>
        !acknowledged.some(
          (item) => item.id === candidate.id && item.version === candidate.version,
        ),
    )
  ) {
    throw new LedgerError(
      'POSSIBLE_DUPLICATE',
      'Possible repeated entry. Ask whether this is separate before retrying with the returned IDs/versions in duplicateConfirmation.',
      { candidates },
    );
  }
}
