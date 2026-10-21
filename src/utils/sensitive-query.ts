/** Shared defaults for log redaction and implicit cache-key protection. */
export const SENSITIVE_QUERY_NAMES = [
  'token', 'access_token', 'refresh_token', 'id_token', 'api_key', 'apikey',
  'key', 'secret', 'client_secret', 'password', 'passwd', 'authorization',
  'signature', 'sig', 'session', 'sessionid', 'csrf', 'csrf_token',
] as const;

const names = new Set<string>(SENSITIVE_QUERY_NAMES);

export function isSensitiveQueryName(name: string): boolean {
  return names.has(name.toLowerCase());
}
