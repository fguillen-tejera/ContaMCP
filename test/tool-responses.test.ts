import type { Client } from '@modelcontextprotocol/client';
import { afterEach, expect, it } from 'vitest';
import { z } from 'zod';
import { LedgerError } from '../src/domain/expense';
import { entryOutput } from '../src/mcp/contracts';
import { toolResult } from '../src/mcp/results';
import { bindings, connect, expenseInput, principal } from './helpers';

const clients: Client[] = [];
afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
});

const record = {
  id: '650a8926-759d-4ecd-98ab-559ab3cf659f',
  description: 'Synthetic bus fare',
  amount: '12.50',
  amountMinor: '1250',
  currency: 'MXN',
  date: '2099-12-20',
  category: 'transport',
  version: 1,
  deletedAt: null,
  createdAt: '2026-11-17T12:00:00.000Z',
  updatedAt: '2026-11-17T12:00:00.000Z',
  ownerId: 'SYNTHETIC-OWNER',
  email: 'synthetic@example.invalid',
  googleSubject: 'SYNTHETIC-SUBJECT',
};
const identity = { userId: 'SYNTHETIC-OWNER', scopes: ['ledger:read'], resourceMetadata: '' };

it('projects tool results before serializing either output channel', async () => {
  const result = await toolResult(identity, 'ledger:read', entryOutput, async () => ({
    entry: record,
    sessionId: 'SYNTHETIC-SESSION',
  }));
  expect(result.isError).not.toBe(true);
  expect(result.structuredContent).toMatchObject({
    entry: { id: record.id, version: 1, amountMinor: '1250', currency: 'MXN' },
  });
  expect(result.content).toEqual([
    { type: 'text', text: JSON.stringify(result.structuredContent) },
  ]);
  const serialized = JSON.stringify(result);
  for (const field of ['ownerId', 'email', 'googleSubject', 'sessionId', 'createdAt', 'updatedAt'])
    expect(serialized).not.toContain(field);
});

it('minimizes duplicate candidates and fails closed on invalid successful output', async () => {
  const duplicate = await toolResult(identity, 'ledger:read', entryOutput, async () => {
    throw new LedgerError('POSSIBLE_DUPLICATE', 'Review the existing entry.', {
      candidates: [record],
      ownerId: record.ownerId,
    });
  });
  expect(duplicate.isError).toBe(true);
  expect(duplicate.structuredContent).toMatchObject({
    error: { code: 'POSSIBLE_DUPLICATE', candidates: [{ id: record.id, version: 1 }] },
  });
  for (const field of ['ownerId', 'googleSubject', 'email', 'createdAt', 'updatedAt'])
    expect(JSON.stringify(duplicate)).not.toContain(field);
  const invalid = await toolResult(identity, 'ledger:read', entryOutput, async () => ({
    entry: { ...record, amountMinor: 'invalid' },
  }));
  expect(invalid.isError).toBe(true);
  expect(invalid.structuredContent).toMatchObject({ error: { code: 'INTERNAL_ERROR' } });
  expect(JSON.stringify(invalid)).not.toContain(record.description);
});

it('keeps preference versions and ledger edits usable while ordinary results omit storage metadata', async () => {
  const config = bindings();
  const user = await principal(config);
  const client = await connect(config, user.token);
  clients.push(client);
  const preferenceArgs = {
    defaultCurrency: 'MXN',
    expectedVersion: 0,
    idempotencyKey: crypto.randomUUID(),
  };
  const saved = await client.callTool({ name: 'set_preferences', arguments: preferenceArgs });
  expect(saved.structuredContent).toEqual({ preferences: { defaultCurrency: 'MXN', version: 1 } });
  expect(
    (await client.callTool({ name: 'set_preferences', arguments: preferenceArgs }))
      .structuredContent,
  ).toEqual(saved.structuredContent);
  const other = await principal(config);
  const otherClient = await connect(config, other.token);
  clients.push(otherClient);
  expect(
    (await otherClient.callTool({ name: 'get_preferences', arguments: {} })).structuredContent,
  ).toMatchObject({ defaultCurrency: null, version: 0 });
  const created = await client.callTool({
    name: 'create_entry',
    arguments: { ...expenseInput(), type: 'expense' },
  });
  const entry = z
    .object({ entry: z.object({ id: z.string(), version: z.number() }) })
    .parse(created.structuredContent).entry;
  const updated = await client.callTool({
    name: 'update_entry',
    arguments: {
      entryId: entry.id,
      expectedVersion: entry.version,
      match: { description: 'Gasolina' },
      changes: { amount: '500.00' },
      idempotencyKey: crypto.randomUUID(),
    },
  });
  expect(updated.isError).not.toBe(true);
  expect(updated.structuredContent).toMatchObject({
    entry: { id: entry.id, version: 2, amountMinor: '50000' },
  });
  expect(JSON.stringify(updated)).not.toContain('updatedAt');
  const exported = await client.callTool({ name: 'export_entries', arguments: {} });
  expect(exported.isError).not.toBe(true);
  expect(exported.structuredContent).toMatchObject({
    entries: [{ id: entry.id, updatedAt: expect.any(String) }],
  });
  expect(JSON.stringify(exported)).not.toContain(user.userId);
  expect(JSON.stringify(exported)).not.toContain(user.subject);
});

it('minimizes recurring, goal, and budget records while retaining their edit preconditions', async () => {
  const config = bindings();
  const user = await principal(config);
  const client = await connect(config, user.token);
  clients.push(client);
  const cases = [
    {
      name: 'create_recurring_entry',
      arguments: {
        description: 'Synthetic membership',
        type: 'expense',
        amount: '10',
        currency: 'MXN',
        category: 'entertainment',
        interval: 'monthly',
        firstDate: '2099-12-21',
        automatic: false,
        idempotencyKey: crypto.randomUUID(),
      },
      field: 'recurring',
    },
    {
      name: 'create_savings_goal',
      arguments: {
        name: 'Synthetic school supplies',
        targetAmount: '100',
        currency: 'MXN',
        idempotencyKey: crypto.randomUUID(),
      },
      field: 'goal',
    },
    {
      name: 'set_monthly_budget',
      arguments: {
        month: '2099-12',
        category: 'transport',
        currency: 'MXN',
        limitAmount: '100',
        idempotencyKey: crypto.randomUUID(),
      },
      field: 'budget',
    },
  ];
  for (const testCase of cases) {
    const result = await client.callTool({ name: testCase.name, arguments: testCase.arguments });
    expect(result.isError, testCase.name).not.toBe(true);
    const value = z
      .record(z.string(), z.object({ id: z.uuid(), version: z.number() }))
      .parse(result.structuredContent)[testCase.field];
    expect(value?.version).toBe(1);
    for (const field of ['ownerId', 'email', 'googleSubject', 'createdAt', 'updatedAt'])
      expect(JSON.stringify(result), testCase.name).not.toContain(field);
  }
});
