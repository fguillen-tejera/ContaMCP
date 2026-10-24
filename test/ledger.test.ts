import { afterEach, describe, expect, it } from 'vitest';
import type { Client } from '@modelcontextprotocol/client';
import { z } from 'zod';
import { expenseSchema } from '../src/domain/expense';
import { verifyAuditChain } from '../src/db/ledger';
import { bindings, connect, dispatch, expenseInput, principal } from './helpers';

const clients: Client[] = [];
afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
});
async function account(scopes?: string[]) {
  const config = bindings();
  const user = await principal(config, scopes);
  const client = await connect(config, user.token);
  clients.push(client);
  return { config, user, client };
}
const created = (result: { structuredContent?: unknown }) =>
  z.object({ expense: expenseSchema }).parse(result.structuredContent).expense;
const listed = (result: { structuredContent?: unknown }) =>
  z
    .object({ expenses: z.array(expenseSchema), nextCursor: z.string().nullable() })
    .parse(result.structuredContent);
const summary = (result: { structuredContent?: unknown }) =>
  z
    .object({
      totals: z.array(
        z.object({
          currency: z.string(),
          amount: z.string(),
          amountMinor: z.string(),
          count: z.number(),
        }),
      ),
    })
    .parse(result.structuredContent).totals;

describe('persisted MCP ledger', () => {
  it('serves 2025 Streamable HTTP requests without session affinity', async () => {
    const config = bindings();
    const user = await principal(config);
    async function legacyRequest(method: string, params: Record<string, unknown>) {
      const response = await dispatch(
        new Request(`${config.APP_ORIGIN}/mcp`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${user.token}`,
            'Content-Type': 'application/json',
            Accept: 'application/json, text/event-stream',
            'MCP-Protocol-Version': '2025-11-25',
          },
          body: JSON.stringify({ jsonrpc: '2.0', id: crypto.randomUUID(), method, params }),
        }),
        config,
      );
      expect(response.status).toBe(200);
      expect(response.headers.get('Mcp-Session-Id')).toBeNull();
      const text = await response.text();
      const payload = response.headers.get('Content-Type')?.includes('text/event-stream')
        ? text
            .split('\n')
            .find((line) => line.startsWith('data:'))
            ?.slice(5)
        : text;
      return z
        .object({ result: z.record(z.string(), z.unknown()) })
        .parse(JSON.parse(payload ?? '')).result;
    }
    await legacyRequest('initialize', {
      protocolVersion: '2025-11-25',
      capabilities: {},
      clientInfo: { name: 'legacy-test', version: '1' },
    });
    const output = await legacyRequest('tools/call', {
      name: 'create_expense',
      arguments: expenseInput(),
    });
    const expense = created(output);
    const next = await legacyRequest('tools/call', { name: 'list_expenses', arguments: {} });
    expect(listed(next).expenses).toEqual([expense]);
  });

  it('creates and retrieves across independent authenticated MCP connections', async () => {
    const { client, config, user } = await account();
    const expense = created(
      await client.callTool({ name: 'create_expense', arguments: expenseInput() }),
    );
    expect(expense.amountMinor).toBe('45000');
    await client.close();
    const anotherConversation = await connect(config, user.token);
    clients.push(anotherConversation);
    const result = listed(
      await anotherConversation.callTool({ name: 'list_expenses', arguments: {} }),
    );
    expect(result.expenses).toEqual([expense]);
  });

  it('rejects unauthenticated and forged identity headers and publishes OAuth discovery', async () => {
    const attempts: Record<string, string>[] = [
      {},
      { 'x-user-id': crypto.randomUUID(), 'x-anti-user-id': 'user' },
      { Authorization: 'Bearer invented' },
    ];
    for (const headers of attempts) {
      const response = await dispatch(
        new Request('http://localhost:8787/mcp', {
          method: 'POST',
          headers,
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
        }),
      );
      expect(response.status).toBe(401);
      expect(response.headers.get('WWW-Authenticate')).toContain('resource_metadata');
    }
    const discovery = await dispatch(
      new Request('http://localhost:8787/.well-known/oauth-protected-resource/mcp'),
    );
    expect(discovery.status).toBe(200);
    expect(await discovery.json()).toMatchObject({
      resource: 'http://localhost:8787/mcp',
      scopes_supported: ['expenses:read', 'expenses:write', 'ledger:read', 'ledger:write'],
    });
  });

  it('corrects only the selected record, preserves history, and changes exact totals', async () => {
    const { client, config } = await account();
    const first = created(
      await client.callTool({ name: 'create_expense', arguments: expenseInput() }),
    );
    const second = created(
      await client.callTool({
        name: 'create_expense',
        arguments: expenseInput({ amount: '0.10' }),
      }),
    );
    const correction = {
      expenseId: first.id,
      match: { date: first.date, currentAmount: first.amount, currency: first.currency },
      expectedVersion: 1,
      idempotencyKey: crypto.randomUUID(),
      changes: { amount: '405.20', category: 'food_drink' },
    };
    const changed = created(
      await client.callTool({ name: 'update_expense', arguments: correction }),
    );
    expect(changed).toMatchObject({
      id: first.id,
      amount: '405.20',
      version: 2,
      category: 'food_drink',
    });
    expect(summary(await client.callTool({ name: 'get_expense_summary', arguments: {} }))).toEqual([
      { currency: 'MXN', amount: '405.30', amountMinor: '40530', count: 2 },
    ]);
    const rows = listed(await client.callTool({ name: 'list_expenses', arguments: {} })).expenses;
    expect(rows.find((row) => row.id === second.id)).toEqual(second);
    const history = await config.DB.prepare(
      'SELECT before_json, after_json FROM expense_mutations WHERE expense_id = ? ORDER BY version',
    )
      .bind(first.id)
      .all<{ before_json: string | null; after_json: string }>();
    expect(history.results).toHaveLength(2);
    expect(history.results[0]?.before_json).toBeNull();
    expect(JSON.parse(history.results[1]?.before_json ?? '{}')).toEqual(first);
    expect(JSON.parse(history.results[1]?.after_json ?? '{}')).toEqual(changed);
    expect(
      created(await client.callTool({ name: 'update_expense', arguments: correction })),
    ).toEqual(changed);
    expect(
      (
        await config.DB.prepare('SELECT COUNT(*) AS n FROM expense_mutations').first<{
          n: number;
        }>()
      )?.n,
    ).toBe(3);
  });

  it('soft-deletes the confirmed record, hides it from reads, and keeps its audit history', async () => {
    const { client, config, user } = await account();
    const keep = created(
      await client.callTool({ name: 'create_expense', arguments: expenseInput() }),
    );
    const gone = created(
      await client.callTool({
        name: 'create_expense',
        arguments: expenseInput({ description: 'Cena', amount: '120.50', category: 'food_drink' }),
      }),
    );
    const key = crypto.randomUUID();
    const args = {
      expenseId: gone.id,
      match: { description: gone.description },
      expectedVersion: gone.version,
      idempotencyKey: key,
    };
    const deleted = created(await client.callTool({ name: 'delete_expense', arguments: args }));
    expect(deleted).toEqual({
      ...gone,
      version: 2,
      deletedAt: expect.any(String),
      updatedAt: expect.any(String),
    });
    expect(created(await client.callTool({ name: 'delete_expense', arguments: args }))).toEqual(
      deleted,
    );
    expect(
      listed(await client.callTool({ name: 'list_expenses', arguments: {} })).expenses,
    ).toEqual([keep]);
    expect(summary(await client.callTool({ name: 'get_expense_summary', arguments: {} }))).toEqual([
      { currency: 'MXN', amount: '450.00', amountMinor: '45000', count: 1 },
    ]);
    expect(
      await client.callTool({
        name: 'delete_expense',
        arguments: { ...args, idempotencyKey: crypto.randomUUID() },
      }),
    ).toMatchObject({
      isError: true,
      structuredContent: { error: { code: 'ALREADY_DELETED' } },
    });
    expect(
      await client.callTool({
        name: 'update_expense',
        arguments: {
          expenseId: gone.id,
          match: { description: gone.description },
          expectedVersion: deleted.version,
          changes: { amount: '1' },
          idempotencyKey: crypto.randomUUID(),
        },
      }),
    ).toMatchObject({
      isError: true,
      structuredContent: { error: { code: 'ALREADY_DELETED' } },
    });
    const history = await config.DB.prepare(
      'SELECT before_json, after_json FROM expense_mutations WHERE expense_id = ?',
    )
      .bind(gone.id)
      .all<{ before_json: string; after_json: string }>();
    expect(history.results).toHaveLength(2);
    expect(history.results[0]?.before_json).toBeNull();
    expect(JSON.parse(history.results[0]?.after_json ?? '{}')).toEqual(gone);
    expect(JSON.parse(history.results[1]?.before_json ?? '{}')).toEqual(gone);
    expect(JSON.parse(history.results[1]?.after_json ?? '{}')).toEqual(deleted);
    expect(user.userId).toBeTruthy();
  });

  it('exports every record including deleted ones and verifies the audit hash chain', async () => {
    const { client, config, user } = await account();
    const first = created(
      await client.callTool({ name: 'create_expense', arguments: expenseInput() }),
    );
    const second = created(
      await client.callTool({
        name: 'create_expense',
        arguments: expenseInput({ description: 'Cena', amount: '120.50', category: 'food_drink' }),
      }),
    );
    await client.callTool({
      name: 'delete_expense',
      arguments: {
        expenseId: second.id,
        match: { description: second.description },
        expectedVersion: second.version,
        idempotencyKey: crypto.randomUUID(),
      },
    });
    const exported = z
      .object({
        exportedAt: z.iso.datetime(),
        count: z.number().int(),
        expenses: z.array(expenseSchema),
      })
      .parse((await client.callTool({ name: 'export_expenses', arguments: {} })).structuredContent);
    expect(exported.count).toBe(2);
    expect(exported.expenses.map((expense) => expense.id)).toEqual([first.id, second.id]);
    expect(exported.expenses.find((expense) => expense.id === second.id)?.deletedAt).toBeTruthy();
    const chain = await verifyAuditChain(config.DB, user.userId);
    expect(chain).toEqual({ valid: true, checked: 3 });
    await config.DB.prepare(
      "UPDATE expense_mutations SET after_json = json_set(after_json, '$.amountMinor', 999) WHERE expense_id = ? AND version = 1",
    )
      .bind(first.id)
      .run();
    const tampered = await verifyAuditChain(config.DB, user.userId);
    expect(tampered).toEqual({ valid: false, expenseId: first.id, version: 1 });
  });

  it('isolates reads, totals, writes, retry keys, and pagination between users', async () => {
    const alice = await account();
    const bob = await account();
    const input = expenseInput();
    const expense = created(
      await alice.client.callTool({ name: 'create_expense', arguments: input }),
    );
    expect(
      listed(await bob.client.callTool({ name: 'list_expenses', arguments: {} })).expenses,
    ).toEqual([]);
    expect(
      summary(await bob.client.callTool({ name: 'get_expense_summary', arguments: {} })),
    ).toEqual([]);
    for (const id of [expense.id, crypto.randomUUID()]) {
      const result = await bob.client.callTool({
        name: 'update_expense',
        arguments: {
          expenseId: id,
          match: { description: expense.description },
          expectedVersion: 1,
          idempotencyKey: crypto.randomUUID(),
          changes: { amount: '1' },
        },
      });
      expect(result).toMatchObject({
        isError: true,
        structuredContent: { error: { code: 'NOT_FOUND' } },
      });
      expect(
        await bob.client.callTool({
          name: 'delete_expense',
          arguments: {
            expenseId: id,
            match: { description: expense.description },
            expectedVersion: 1,
            idempotencyKey: crypto.randomUUID(),
          },
        }),
      ).toMatchObject({
        isError: true,
        structuredContent: { error: { code: 'NOT_FOUND' } },
      });
    }
    const own = created(await bob.client.callTool({ name: 'create_expense', arguments: input }));
    expect(own.id).not.toBe(expense.id);
    expect(
      listed(await alice.client.callTool({ name: 'list_expenses', arguments: {} })).expenses,
    ).toEqual([expense]);
  });

  it('deduplicates concurrent retries and rejects key reuse with changed input', async () => {
    const { client, config } = await account();
    const input = expenseInput();
    const results = await Promise.all(
      Array.from({ length: 4 }, () =>
        client.callTool({ name: 'create_expense', arguments: input }),
      ),
    );
    const expense = created(results[0] ?? {});
    expect(results.map(created)).toEqual([expense, expense, expense, expense]);
    const conflict = await client.callTool({
      name: 'create_expense',
      arguments: { ...input, amount: '451' },
    });
    expect(conflict).toMatchObject({
      isError: true,
      structuredContent: { error: { code: 'IDEMPOTENCY_CONFLICT' } },
    });
    expect(
      (
        await config.DB.prepare('SELECT COUNT(*) AS n FROM expense_mutations').first<{
          n: number;
        }>()
      )?.n,
    ).toBe(1);
    expect(
      listed(await client.callTool({ name: 'list_expenses', arguments: {} })).expenses,
    ).toHaveLength(1);
  });

  it('prevents lost corrections when two clients update the same version', async () => {
    const { client, config } = await account();
    const expense = created(
      await client.callTool({ name: 'create_expense', arguments: expenseInput() }),
    );
    const attempts = await Promise.all(
      ['400', '500'].map((amount) =>
        client.callTool({
          name: 'update_expense',
          arguments: {
            expenseId: expense.id,
            match: { description: expense.description },
            expectedVersion: 1,
            changes: { amount },
            idempotencyKey: crypto.randomUUID(),
          },
        }),
      ),
    );
    expect(attempts.filter((result) => !result.isError)).toHaveLength(1);
    expect(attempts.find((result) => result.isError)).toMatchObject({
      structuredContent: { error: { code: 'CONFLICT' } },
    });
    expect(
      (
        await config.DB.prepare('SELECT COUNT(*) AS n FROM expense_mutations WHERE expense_id = ?')
          .bind(expense.id)
          .first<{ n: number }>()
      )?.n,
    ).toBe(2);
  });

  it('groups currencies and applies inclusive date/category filters with exact decimals', async () => {
    const { client } = await account();
    for (const fields of [
      { amount: '0.10', date: '2026-10-01' },
      { amount: '0.20', date: '2026-10-31' },
      { amount: '100', currency: 'USD' },
      { amount: '10', currency: 'EUR' },
      { amount: '900', date: '2026-09-30' },
      { amount: '800', category: 'groceries' },
    ])
      await client.callTool({ name: 'create_expense', arguments: expenseInput(fields) });
    expect(
      summary(
        await client.callTool({
          name: 'get_expense_summary',
          arguments: { from: '2026-10-01', to: '2026-10-31', category: 'transport' },
        }),
      ),
    ).toEqual([
      { currency: 'EUR', amount: '10.00', amountMinor: '1000', count: 1 },
      { currency: 'MXN', amount: '0.30', amountMinor: '30', count: 2 },
      { currency: 'USD', amount: '100.00', amountMinor: '10000', count: 1 },
    ]);
    expect(
      summary(
        await client.callTool({ name: 'get_expense_summary', arguments: { currency: 'USD' } }),
      ),
    ).toHaveLength(1);
  });

  it('preserves totals exceeding the JavaScript safe integer range', async () => {
    const { client, config, user } = await account();
    await config.DB.prepare(`WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<10000)
      INSERT INTO expenses (id, owner_id, description, amount_minor, currency, date, category, version, created_at, updated_at)
      SELECT 'synthetic-'||x, ?, 'Synthetic precision fixture', 999999999999, 'MXN', '2026-10-23', 'other', 1, ?, ? FROM n`)
      .bind(user.userId, new Date().toISOString(), new Date().toISOString())
      .run();
    expect(summary(await client.callTool({ name: 'get_expense_summary', arguments: {} }))).toEqual([
      {
        currency: 'MXN',
        amount: '99999999999900.00',
        amountMinor: '9999999999990000',
        count: 10000,
      },
    ]);
  });

  it('paginates deterministically without overlap and filters the owner on every page', async () => {
    const { client } = await account();
    const ids: string[] = [];
    for (let i = 0; i < 5; i++)
      ids.push(
        created(
          await client.callTool({
            name: 'create_expense',
            arguments: expenseInput({ description: `Page ${crypto.randomUUID()}` }),
          }),
        ).id,
      );
    let cursor: string | null = null;
    const seen: string[] = [];
    do {
      const page = listed(
        await client.callTool({
          name: 'list_expenses',
          arguments: { limit: 2, ...(cursor ? { cursor } : {}) },
        }),
      );
      expect(page.expenses.length).toBeLessThanOrEqual(2);
      seen.push(...page.expenses.map((expense) => expense.id));
      cursor = page.nextCursor;
    } while (cursor);
    expect(seen).toEqual([...ids].sort().reverse());
    const bob = await account();
    const foreignCursor = btoa(JSON.stringify({ date: '9999-12-31', id: ids[0] }));
    expect(
      listed(
        await bob.client.callTool({ name: 'list_expenses', arguments: { cursor: foreignCursor } }),
      ).expenses,
    ).toEqual([]);
    expect(
      await client.callTool({ name: 'list_expenses', arguments: { cursor: 'invalid!' } }),
    ).toMatchObject({ isError: true, structuredContent: { error: { code: 'INVALID_INPUT' } } });
  });

  it.each([
    { amount: 450 },
    { amount: '1,000.00' },
    { amount: '$450' },
    { amount: '0' },
    { amount: '-1' },
    { amount: '0.001' },
    { amount: '10000000000' },
    { date: '2026-02-30' },
    { date: 'yesterday' },
    { description: ' ' },
    { currency: undefined },
    { currency: 'JPY' },
    { userId: 'forged-user' },
  ])('rejects ambiguous/invalid create fields: %j', async (fields) => {
    const { client } = await account();
    const result = await client.callTool({
      name: 'create_expense',
      arguments: expenseInput(fields),
    });
    expect(result.isError).toBe(true);
    expect(
      listed(await client.callTool({ name: 'list_expenses', arguments: {} })).expenses,
    ).toEqual([]);
  });

  it('rejects empty corrections, reversed ranges, missing retry keys, and unbounded pages', async () => {
    const { client } = await account();
    const calls = [
      {
        name: 'update_expense',
        arguments: {
          expenseId: crypto.randomUUID(),
          match: { description: 'Synthetic' },
          expectedVersion: 1,
          changes: {},
          idempotencyKey: crypto.randomUUID(),
        },
      },
      { name: 'list_expenses', arguments: { limit: 101 } },
      { name: 'get_expense_summary', arguments: { from: '2026-10-31', to: '2026-10-01' } },
      { name: 'create_expense', arguments: expenseInput({ idempotencyKey: undefined }) },
    ];
    for (const call of calls) expect((await client.callTool(call)).isError).toBe(true);
  });

  it('enforces scopes and publishes appropriate tool annotations and output schemas', async () => {
    const { client } = await account(['expenses:read']);
    const denied = await client.callTool({ name: 'create_expense', arguments: expenseInput() });
    expect(denied).toMatchObject({
      isError: true,
      structuredContent: { error: { code: 'FORBIDDEN' } },
    });
    expect(denied._meta?.['mcp/www_authenticate']).toEqual([
      expect.stringContaining('error="insufficient_scope"'),
    ]);
    const tools = (await client.listTools()).tools;
    expect(tools.map((tool) => tool.name)).toEqual(
      expect.arrayContaining([
        'create_expense',
        'list_expenses',
        'update_expense',
        'delete_expense',
        'get_expense_summary',
        'export_expenses',
        'create_entry',
        'list_entries',
        'update_entry',
        'delete_entry',
        'get_cash_flow',
        'export_entries',
        'create_recurring_entry',
        'list_recurring_entries',
        'confirm_recurring_payment',
        'cancel_recurring_entry',
        'update_recurring_entry',
        'skip_recurring_occurrence',
        'create_savings_goal',
        'list_savings_goals',
        'contribute_to_savings_goal',
        'update_savings_goal',
      ]),
    );
    expect(tools.find((tool) => tool.name === 'list_expenses')?.annotations?.readOnlyHint).toBe(
      true,
    );
    expect(tools.find((tool) => tool.name === 'update_expense')?.annotations?.destructiveHint).toBe(
      true,
    );
    expect(tools.find((tool) => tool.name === 'delete_expense')?.annotations?.destructiveHint).toBe(
      true,
    );
    for (const tool of tools) expect(tool.outputSchema).toBeDefined();
  });
});
