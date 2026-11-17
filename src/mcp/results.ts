import type { CallToolResult } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { Diagnostics } from '../diagnostics';
import { LedgerError } from '../domain/expense';
import { entryResponseSchema } from './contracts';

export type Principal = { userId: string; scopes: readonly string[]; resourceMetadata: string };

export async function toolResult(
  principal: Principal,
  scope: string,
  outputSchema: z.ZodType<Record<string, unknown>>,
  action: () => Promise<Record<string, unknown>>,
  diagnostics?: Diagnostics,
): Promise<CallToolResult> {
  const required = scope.endsWith(':write') ? [scope.replace(':write', ':read'), scope] : [scope];
  if (required.some((permission) => !principal.scopes.includes(permission))) {
    return {
      ...failure(
        'FORBIDDEN',
        `Authorization requires ${required.join(' and ')}. Reconnect with these permissions.`,
      ),
      _meta: {
        'mcp/www_authenticate': [
          `Bearer resource_metadata="${principal.resourceMetadata}", error="insufficient_scope", error_description="Reconnect with the required scope", scope="${required.join(' ')}"`,
        ],
      },
    };
  }
  try {
    const result = outputSchema.safeParse(await action());
    if (!result.success) {
      diagnostics?.report('tool_failed');
      return failure(
        'INTERNAL_ERROR',
        'Operation returned an invalid result. Retry with the same idempotency key if this was a mutation.',
      );
    }
    const output = result.data;
    return { content: [{ type: 'text', text: JSON.stringify(output) }], structuredContent: output };
  } catch (error) {
    if (error instanceof LedgerError) return failure(error.code, error.message, error.details);
    if (error instanceof z.ZodError)
      return failure('INVALID_INPUT', 'Invalid input. Check the tool schema.');
    diagnostics?.report('tool_failed');
    return failure(
      'INTERNAL_ERROR',
      'Operation failed. Retry with the same idempotency key if this was a mutation.',
    );
  }
}

function failure(code: string, message: string, details?: Record<string, unknown>): CallToolResult {
  const parsed = z
    .object({ candidates: z.array(entryResponseSchema).optional() })
    .safeParse(details ?? {});
  const output = { error: { code, message, ...(parsed.success ? parsed.data : {}) } };
  return {
    isError: true,
    structuredContent: output,
    content: [{ type: 'text', text: JSON.stringify(output) }],
  };
}
