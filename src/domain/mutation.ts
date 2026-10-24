export async function requestHash(operation: string, input: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify({ operation, input }));
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
}
