import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { OAuth2Client } from 'google-auth-library';
import fs from 'fs/promises';
import { INVALID_TOKEN_SCOPES_MESSAGE } from '../../../auth/scopes.js';

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

const READONLY_SCOPE = 'https://www.googleapis.com/auth/calendar.events.readonly';
const BROAD_SCOPE = 'https://www.googleapis.com/auth/calendar';

describe('TokenManager - persisted scope validation', () => {
  let tokenManager: any;
  let mockOAuth2Client: OAuth2Client;
  const mockedFs = fs as any;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockOAuth2Client = new OAuth2Client('client-id', 'client-secret', 'redirect-uri');
    mockedFs.mkdir.mockResolvedValue(undefined);
    mockedFs.access.mockResolvedValue(undefined);
    mockedFs.writeFile.mockResolvedValue(undefined);
    const { TokenManager } = await import('../../../auth/tokenManager.js');
    tokenManager = new TokenManager(mockOAuth2Client);
    vi.spyOn(mockOAuth2Client, 'setCredentials');
  });

  afterEach(() => {
    vi.resetModules();
  });

  it('accepts exact readonly scope on save and load', async () => {
    mockedFs.readFile.mockResolvedValue(JSON.stringify({}));
    await tokenManager.saveTokens({ access_token: 'a', refresh_token: 'r', scope: READONLY_SCOPE });
    expect(mockedFs.writeFile).toHaveBeenCalled();
    expect(mockOAuth2Client.setCredentials).toHaveBeenCalled();

    vi.clearAllMocks();
    mockedFs.access.mockResolvedValue(undefined);
    mockedFs.readFile.mockResolvedValue(
      JSON.stringify({ normal: { access_token: 'a', refresh_token: 'r', scope: READONLY_SCOPE } }),
    );
    const loaded = await tokenManager.loadSavedTokens();
    expect(loaded).toBe(true);
    expect(mockOAuth2Client.setCredentials).toHaveBeenCalled();

    const accounts = await tokenManager.loadAllAccounts();
    expect(accounts.size).toBe(1);
    expect(accounts.has('normal')).toBe(true);
  });

  it('rejects missing scope on save without write/setCredentials', async () => {
    await expect(tokenManager.saveTokens({ access_token: 'a', refresh_token: 'r' })).rejects.toThrow(
      INVALID_TOKEN_SCOPES_MESSAGE,
    );
    expect(mockedFs.writeFile).not.toHaveBeenCalled();
    expect(mockOAuth2Client.setCredentials).not.toHaveBeenCalled();
  });

  it('rejects broad calendar scope on save without write/setCredentials', async () => {
    await expect(
      tokenManager.saveTokens({ access_token: 'a', refresh_token: 'r', scope: BROAD_SCOPE }),
    ).rejects.toThrow(INVALID_TOKEN_SCOPES_MESSAGE);
    expect(mockedFs.writeFile).not.toHaveBeenCalled();
    expect(mockOAuth2Client.setCredentials).not.toHaveBeenCalled();
  });

  it('rejects mixed broad+readonly scope on save without write/setCredentials', async () => {
    await expect(
      tokenManager.saveTokens({
        access_token: 'a',
        refresh_token: 'r',
        scope: `${READONLY_SCOPE} ${BROAD_SCOPE}`,
      }),
    ).rejects.toThrow(INVALID_TOKEN_SCOPES_MESSAGE);
    expect(mockedFs.writeFile).not.toHaveBeenCalled();
    expect(mockOAuth2Client.setCredentials).not.toHaveBeenCalled();
  });

  it('loadSavedTokens returns false for missing scope without I/O side effects', async () => {
    mockedFs.readFile.mockResolvedValue(
      JSON.stringify({ normal: { access_token: 'a', refresh_token: 'r' } }),
    );
    const result = await tokenManager.loadSavedTokens();
    expect(result).toBe(false);
    expect(mockOAuth2Client.setCredentials).not.toHaveBeenCalled();
    expect(mockedFs.writeFile).not.toHaveBeenCalled();
    expect(mockedFs.unlink).not.toHaveBeenCalled();
  });

  it('loadSavedTokens returns false for broad scope without I/O side effects', async () => {
    mockedFs.readFile.mockResolvedValue(
      JSON.stringify({ normal: { access_token: 'a', refresh_token: 'r', scope: BROAD_SCOPE } }),
    );
    const result = await tokenManager.loadSavedTokens();
    expect(result).toBe(false);
    expect(mockOAuth2Client.setCredentials).not.toHaveBeenCalled();
    expect(mockedFs.writeFile).not.toHaveBeenCalled();
    expect(mockedFs.unlink).not.toHaveBeenCalled();
  });

  it('loadSavedTokens returns false for mixed broad+readonly without I/O side effects', async () => {
    mockedFs.readFile.mockResolvedValue(
      JSON.stringify({
        normal: { access_token: 'a', refresh_token: 'r', scope: `${READONLY_SCOPE} ${BROAD_SCOPE}` },
      }),
    );
    const result = await tokenManager.loadSavedTokens();
    expect(result).toBe(false);
    expect(mockOAuth2Client.setCredentials).not.toHaveBeenCalled();
    expect(mockedFs.writeFile).not.toHaveBeenCalled();
    expect(mockedFs.unlink).not.toHaveBeenCalled();
  });

  it('loadAllAccounts returns empty map for missing/broad scope without rewriting', async () => {
    mockedFs.readFile.mockResolvedValue(
      JSON.stringify({ normal: { access_token: 'a', refresh_token: 'r', scope: BROAD_SCOPE } }),
    );
    const accounts = await tokenManager.loadAllAccounts();
    expect(accounts.size).toBe(0);
    expect(mockedFs.writeFile).not.toHaveBeenCalled();
    expect(mockedFs.unlink).not.toHaveBeenCalled();
  });

  it('loadAllAccounts returns empty map when any account has invalid scope', async () => {
    mockedFs.readFile.mockResolvedValue(
      JSON.stringify({
        normal: { access_token: 'a', refresh_token: 'r', scope: READONLY_SCOPE },
        work: { access_token: 'b', refresh_token: 'rb', scope: BROAD_SCOPE },
      }),
    );
    const accounts = await tokenManager.loadAllAccounts();
    expect(accounts.size).toBe(0);
    expect(mockedFs.writeFile).not.toHaveBeenCalled();
    expect(mockedFs.unlink).not.toHaveBeenCalled();
  });

  it('validator uses fixed message and never echoes scope values', async () => {
    const { assertValidGrantedScopes } = await import('../../../auth/scopes.js');
    const sensitive = `${READONLY_SCOPE} https://example.invalid/sensitive`;
    try {
      assertValidGrantedScopes(sensitive);
      expect.unreachable();
    } catch (error: any) {
      expect(error.message).toBe(INVALID_TOKEN_SCOPES_MESSAGE);
      expect(error.message).not.toContain('sensitive');
      expect(error.message).not.toContain('example.invalid');
    }
  });
});
