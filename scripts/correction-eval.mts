import { readFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { URL as NodeURL } from 'node:url';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { z } from 'zod';
import { createExpenseSchema, expenseSchema, toMinor } from '../src/domain/expense.ts';
import { stagingLogin } from './staging-auth.ts';

const baseCases = z
  .array(
    z.strictObject({
      id: z.string(),
      kind: z.string(),
      records: z.array(createExpenseSchema.omit({ idempotencyKey: true })),
      prompt: z.string(),
      expected: z.enum(['clarify', 'update']),
      targetIndex: z.number().int().nullable(),
      newAmount: z.string(),
    }),
  )
  .parse(
    JSON.parse(
      await readFile(
        new NodeURL('../fixtures/correction-evaluation.es.json', import.meta.url),
        'utf8',
      ),
    ),
  );
const cases = [
  ...baseCases,
  ...baseCases.map((c) => ({
    ...c,
    id: `post-${c.id}`,
    prompt: c.prompt.replaceAll('2088-01', '2088-02').replaceAll('risk23', 'risk23-post'),
    records: c.records.map((r) => ({
      ...r,
      description: r.description.replaceAll('risk23', 'risk23-post'),
      date: r.date?.replaceAll('2088-01', '2088-02'),
    })),
  })),
];
const endpoint = new URL(process.argv[2] ?? 'https://staging.invalid/mcp');
if (
  endpoint.protocol !== 'https:' ||
  endpoint.pathname !== '/mcp' ||
  endpoint.search ||
  endpoint.hash ||
  endpoint.username ||
  endpoint.password ||
  endpoint.hostname.endsWith('.invalid')
)
  throw new Error('Supply the approved staging /mcp endpoint.');
const resultSchema = z.object({ expense: expenseSchema });
const listSchema = z.object({
  expenses: z.array(expenseSchema),
  nextCursor: z.string().nullable(),
});
const client = new Client({ name: 'contamcp-correction-evaluation', version: '1' });
const commands = createInterface({ input: process.stdin });
let accessToken = '';
let refreshToken = '';
let clientId = '';
let expiresAt = 0;
const observations: {
  id: string;
  expected: string;
  response: string;
  correctUpdate: boolean;
  unnecessaryClarification: boolean;
  wrongRecordMutations: number;
  changedRecords: number;
  pass: boolean;
}[] = [];
const ids = new Map<string, string[]>();
async function snapshot() {
  let cursor: string | null = null;
  const records = [];
  do {
    const r = listSchema.parse(
      (
        await client.callTool({
          name: 'list_expenses',
          arguments: { limit: 100, ...(cursor ? { cursor } : {}) },
        })
      ).structuredContent,
    );
    records.push(...r.expenses);
    cursor = r.nextCursor;
    if (records.length > 1000) throw new Error('Evaluation snapshot exceeded safety bound.');
  } while (cursor);
  return records;
}
let before: Awaited<ReturnType<typeof snapshot>> | undefined;
let active: string | undefined;
try {
  const grant = await stagingLogin(endpoint, 'synthetic correction evaluation account');
  accessToken = grant.access_token;
  refreshToken = grant.refresh_token;
  clientId = grant.clientId;
  expiresAt = Date.now() + grant.expires_in * 1000;
  await client.connect(
    new StreamableHTTPClientTransport(endpoint, {
      fetch: async (input, init) => {
        if (Date.now() > expiresAt - 30000) {
          const response = await fetch(new URL('/oauth/token', endpoint), {
            method: 'POST',
            body: new URLSearchParams({
              grant_type: 'refresh_token',
              client_id: clientId,
              refresh_token: refreshToken,
              resource: endpoint.href,
            }),
          });
          if (!response.ok) throw new Error('Evaluation refresh failed');
          const t = z
            .object({ access_token: z.string(), refresh_token: z.string(), expires_in: z.number() })
            .parse(await response.json());
          accessToken = t.access_token;
          refreshToken = t.refresh_token;
          expiresAt = Date.now() + t.expires_in * 1000;
        }
        const headers = new Headers(
          init?.headers ?? (input instanceof Request ? input.headers : undefined),
        );
        headers.set('Authorization', `Bearer ${accessToken}`);
        return fetch(input, { ...init, headers, signal: AbortSignal.timeout(20000) });
      },
    }),
  );
  console.log(
    'READY: commands seed, before CASE_ID, score CASE_ID clarified|completed|failed, results, quit. Never run other ledger writes during a case.',
  );
  for await (const line of commands) {
    const [command, id, response] = line.trim().split(/\s+/);
    try {
      if (command === 'quit') break;
      if (command === 'seed') {
        const prior = await snapshot();
        if (
          prior.some((row) =>
            cases.some((c) => c.records.some((r) => r.description === row.description)),
          )
        )
          throw new Error(
            'Fixtures already exist; use a fresh fixture date/name set instead of duplicating.',
          );
        for (const c of cases) {
          const created = [];
          for (const record of c.records) {
            const r = resultSchema.parse(
              (
                await client.callTool({
                  name: 'create_expense',
                  arguments: { ...record, idempotencyKey: crypto.randomUUID() },
                })
              ).structuredContent,
            );
            created.push(r.expense.id);
          }
          ids.set(c.id, created);
        }
        console.log(
          JSON.stringify({
            seeded: cases.reduce((n, c) => n + c.records.length, 0),
            cases: cases.length,
          }),
        );
      } else if (command === 'before') {
        if (active) throw new Error('Finish the active case before starting another.');
        const c = cases.find((c) => c.id === id);
        if (!c) throw new Error('Unknown case');
        if (observations.some((row) => row.id === id)) throw new Error('Case already scored.');
        before = await snapshot();
        active = c.id;
        if (c.expected === 'update' && !ids.has(c.id))
          ids.set(
            c.id,
            c.records.map((r) => {
              const matches =
                before?.filter(
                  (e) =>
                    e.description === r.description &&
                    e.date === r.date &&
                    e.currency === r.currency &&
                    e.amount === r.amount,
                ) ?? [];
              if (matches.length !== 1) throw new Error('Fixture baseline is not unique');
              return matches[0]?.id ?? '';
            }),
          );
        console.log(JSON.stringify({ ready: c.id, expected: c.expected, prompt: c.prompt }));
      } else if (command === 'score') {
        const c = cases.find((c) => c.id === id);
        if (
          !c ||
          !before ||
          active !== id ||
          !['clarified', 'completed', 'failed'].includes(response ?? '')
        )
          throw new Error('Start the case before scoring it');
        const after = await snapshot();
        const target = c.targetIndex === null ? undefined : ids.get(c.id)?.[c.targetIndex];
        const old = new Map(before.map((e) => [e.id, e]));
        const changed = after.filter((e) => JSON.stringify(old.get(e.id)) !== JSON.stringify(e));
        const deleted = before.filter((e) => !after.some((a) => a.id === e.id)).length;
        if (
          c.expected === 'update' &&
          response === 'completed' &&
          changed.length === 0 &&
          deleted === 0
        ) {
          console.log(
            JSON.stringify({
              pending: c.id,
              reason:
                'No mutation observed. Wait for the final client response, or score failed if it finished without writing.',
            }),
          );
          continue;
        }
        const wrong = changed.filter((e) => e.id !== target).length + deleted;
        const targetBefore = before.find((e) => e.id === target);
        const targetAfter = after.find((e) => e.id === target);
        const correct =
          c.expected === 'update' &&
          changed.length === 1 &&
          wrong === 0 &&
          targetBefore !== undefined &&
          targetAfter !== undefined &&
          targetAfter.amountMinor === String(toMinor(c.newAmount)) &&
          targetAfter.version === targetBefore.version + 1 &&
          JSON.stringify({
            ...targetAfter,
            amount: targetBefore.amount,
            amountMinor: targetBefore.amountMinor,
            version: targetBefore.version,
            updatedAt: targetBefore.updatedAt,
          }) === JSON.stringify(targetBefore);
        const row = {
          id: c.id,
          expected: c.expected,
          response: response ?? 'failed',
          correctUpdate: correct,
          unnecessaryClarification:
            c.expected === 'update' && response === 'clarified' && changed.length === 0,
          wrongRecordMutations: wrong,
          changedRecords: changed.length + deleted,
          pass:
            c.expected === 'clarify'
              ? response === 'clarified' && changed.length === 0 && deleted === 0
              : correct,
        };
        observations.push(row);
        console.log(JSON.stringify(row));
        before = undefined;
        active = undefined;
      } else if (command === 'results') {
        console.log(
          JSON.stringify({
            observations,
            executed: observations.length,
            expectedUpdates: observations.filter((x) => x.expected === 'update').length,
            correctUpdates: observations.filter((x) => x.correctUpdate).length,
            unnecessaryClarifications: observations.filter((x) => x.unnecessaryClarification)
              .length,
            wrongRecordMutations: observations.reduce((n, x) => n + x.wrongRecordMutations, 0),
            passed: observations.filter((x) => x.pass).length,
          }),
        );
      } else throw new Error('Unknown command');
    } catch {
      console.log(
        JSON.stringify({
          command,
          id,
          error: 'Evaluation command failed; inspect fixture state before continuing.',
        }),
      );
    }
  }
} catch {
  console.error(
    'FAIL: correction evaluation incomplete. Credentials and financial responses were not logged.',
  );
  process.exitCode = 1;
} finally {
  commands.close();
  await client.close();
}
