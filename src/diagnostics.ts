export type DiagnosticEvent =
  | 'automatic_recording_failed'
  | 'request_failed'
  | 'authorization_failed'
  | 'google_verification_failed'
  | 'oauth_rejected'
  | 'tool_failed';

export type Diagnostics = { requestId: string; report(event: DiagnosticEvent): void };

export function diagnostics(): Diagnostics {
  const requestId = crypto.randomUUID();
  return {
    requestId,
    // Only fixed event names and a server-generated correlation ID may reach logs.
    report: (event) => console.warn(JSON.stringify({ event, requestId })),
  };
}
