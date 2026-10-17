import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { OAuth2Client } from 'google-auth-library';
import fs from 'fs/promises';

vi.mock('fs/promises', () => ({
  default: {
    readFile: vi.fn(),
    writeFile: vi.fn(),
    unlink: vi.fn(),
    access: vi.fn(),
    mkdir: vi.fn(),
  },
}));

vi.mock('../../../auth/utils.js', () => ({
  getSecureTokenPath: vi.fn(() => '/mock/path/tokens.json'),
  getAccountMode: vi.fn(() => 'normal'),
  getLegacyTokenPath: vi.fn(() => '/mock/legacy/tokens.json'),
}));

vi.mock('../../../auth/paths.js', () => ({
  validateAccountId: vi.fn((id: string) => {
    if (id.includes('@') || id.includes('..')) {
      throw new Error('Invalid account ID');
    }
    return true;
  }),
}));

describe('TokenManager - reject legacy top-level token format', () => {
  let tokenManager: any;
  let mockOAuth2Client: OAuth2Client;
  const mockedFs = fs as any;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockOAuth2Client = new OAuth2Client('client-id', 'client-secret', 'redirect-uri');
    mockedFs.mkdir.mockResolvedValue(undefined);
    mockedFs.access.mockResolvedValue(undefined);
    const { TokenManager } = await import('../../../auth/tokenManager.js');
    tokenManager = new TokenManager(mockOAuth2Client);
    vi.spyOn(mockOAuth2Client, 'setCredentials');
  });

  afterEach(() => {
    vi.resetModules();
  });

  it('loadSavedTokens rejects legacy access_token file without migration or I/O side effects', async () => {
    mockedFs.readFile.mockResolvedValue(JSON.stringify({ access_token: 'legacy-access' }));

    const result = await tokenManager.loadSavedTokens();

    expect(result).toBe(false);
    expect(mockedFs.writeFile).not.toHaveBeenCalled();
    expect(mockedFs.unlink).not.toHaveBeenCalled();
    expect(mockOAuth2Client.setCredentials).not.toHaveBeenCalled();
  });

  it('loadSavedTokens rejects legacy refresh_token file without migration or I/O side effects', async () => {
    mockedFs.readFile.mockResolvedValue(JSON.stringify({ refresh_token: 'legacy-refresh' }));

    const result = await tokenManager.loadSavedTokens();

    expect(result).toBe(false);
    expect(mockedFs.writeFile).not.toHaveBeenCalled();
    expect(mockedFs.unlink).not.toHaveBeenCalled();
    expect(mockOAuth2Client.setCredentials).not.toHaveBeenCalled();
  });

  it('loadAllAccounts returns no authenticated accounts for legacy format without rewriting', async () => {
    mockedFs.readFile.mockResolvedValue(
      JSON.stringify({ access_token: 'legacy-access', refresh_token: 'legacy-refresh' }),
    );

    const accounts = await tokenManager.loadAllAccounts();

    expect(accounts.size).toBe(0);
    expect(mockedFs.writeFile).not.toHaveBeenCalled();
    expect(mockedFs.unlink).not.toHaveBeenCalled();
  });

  it('preserves valid multi-account readonly files', async () => {
    mockedFs.readFile.mockResolvedValue(
      JSON.stringify({
        normal: {
          access_token: 'valid-access',
          refresh_token: 'valid-refresh',
          scope: 'https://www.googleapis.com/auth/calendar.events.readonly',
        },
      }),
    );
    mockedFs.writeFile.mockResolvedValue(undefined);

    const loaded = await tokenManager.loadSavedTokens();
    expect(loaded).toBe(true);
    expect(mockOAuth2Client.setCredentials).toHaveBeenCalled();

    const accounts = await tokenManager.loadAllAccounts();
    expect(accounts.size).toBe(1);
    expect(accounts.has('normal')).toBe(true);
  });
});
