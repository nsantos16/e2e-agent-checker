import { Data } from 'effect';
export class RunError extends Data.TaggedError('RunError')<{ code: string; message: string; retryAt?: number }> {
  constructor(code: string, message: string, retryAt?: number) {
    super({ code, message, retryAt });
  }
}
// Provider stderr and RPC errors can contain credentials. Public failures use fixed messages.
export function nativeFailure(error: unknown): RunError {
  if (error instanceof RunError) return error;
  const message = String(error);
  if (/ENOENT/.test(message))
    return new RunError('INSTALLATION_MISSING', 'Native executable not found. Check the binary path or install it yourself.');
  if (/401|unauthorized|expired|refresh.token|invalid.grant/i.test(message))
    return new RunError('AUTH_EXPIRED', 'Native login expired or was rejected. Reconnect this instance in your terminal.');
  if (/429|rate.limit|usage.limit|quota|usageLimitExceeded/i.test(message))
    return new RunError(
      'USAGE_EXHAUSTED',
      'The provider reported a usage limit. Retry after its reset; no account or model was substituted.',
    );
  if (/timeout|time limit/i.test(message))
    return new RunError('PROVIDER_TIMEOUT', 'The native provider did not respond in time. Refresh this instance.');
  return new RunError(
    'PROVIDER_UNAVAILABLE',
    'The native provider could not complete this operation. Check its installation and login, then refresh.',
  );
}
