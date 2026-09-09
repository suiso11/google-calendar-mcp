/**
 * Shared Google Calendar OAuth scopes.
 * Single source of truth to prevent security drift between transports.
 */
export const READONLY_CALENDAR_SCOPES = [
  'https://www.googleapis.com/auth/calendar.events.readonly',
];

export const INVALID_TOKEN_SCOPES_MESSAGE =
  'Invalid token scopes; re-authentication required';

/**
 * Pure fail-closed validator for persisted credential scope strings.
 * Granted scopes are whitespace-separated; they must contain every
 * READONLY_CALENDAR_SCOPES entry and nothing outside that allowlist.
 * Never echoes scopes or tokens; callers must use the fixed message.
 */
export function isValidGrantedScopes(scope: unknown): boolean {
  if (typeof scope !== 'string') {
    return false;
  }
  const granted = scope.split(/\s+/).filter((entry) => entry.length > 0);
  if (granted.length === 0) {
    return false;
  }
  const allowed = new Set<string>(READONLY_CALENDAR_SCOPES);
  for (const required of READONLY_CALENDAR_SCOPES) {
    if (!granted.includes(required)) {
      return false;
    }
  }
  for (const entry of granted) {
    if (!allowed.has(entry)) {
      return false;
    }
  }
  return true;
}

/**
 * Throw only the fixed non-sensitive message when scopes are invalid.
 */
export function assertValidGrantedScopes(scope: unknown): void {
  if (!isValidGrantedScopes(scope)) {
    throw new Error(INVALID_TOKEN_SCOPES_MESSAGE);
  }
}
