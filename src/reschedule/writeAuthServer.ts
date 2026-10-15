// M5 SEPARATE write-consent loopback server (out-of-band user consent only).
//
// This server performs a REAL Google OAuth 2.0 authorization-code flow for
// the EXACT least-privilege write scope
// (`https://www.googleapis.com/auth/calendar.events` ONLY, from
// `./provider.js` `WRITE_SCOPES`) and persists the grant into the SEPARATE
// write token file (`./writeTokenStore.js`, 0600). It never reads or writes
// the readonly token file, never reuses readonly grants, and never performs
// any calendar read/write: after the user approves at Google, a TEST event
// plus explicit approval is still required before any reschedule.
//
// Security properties (mirror the existing readonly `src/auth/server.js`
// patterns without sharing its namespace):
// - Loopback ONLY (`127.0.0.1`) with an EXACT redirect URI
//   (`http://127.0.0.1:<actual-port>/oauth2callback`) bound to the port the
//   server really listens on (preferred `3500-3505`, fallback `3510`).
// - PKCE-S256 + random `state` per flow; the state-bearing Google URL is
//   NEVER printed (the console shows only the local landing URL whose page
//   links to Google).
// - Single-use callback: the pending flow is consumed by the first code
//   exchange (success or failure); replays and stale states get 403.
// - Bounded TTL (default 12 minutes): the server stops itself when the
//   window expires; grants outside the window are impossible.
// - Grant validation BEFORE persist: a broad or readonly `scope` (or a
//   missing refresh token) refuses the whole grant and writes nothing.
// - Log discipline: fixed messages only (port/window/account bookkeeping).
//   Codes, states, scopes, and token bytes are never logged.

import { CodeChallengeMethod, OAuth2Client } from "google-auth-library";
import crypto from "node:crypto";
import http from "node:http";
import { URL } from "node:url";
import open from "open";
import { loadCredentials } from "../auth/client.js";
import { validateAccountId } from "../auth/paths.js";
import { WRITE_SCOPES } from "./provider.js";
import { getWriteTokenPath, saveWriteCredentials } from "./writeTokenStore.js";
import {
  loadWebFile,
  renderAuthError,
  renderAuthLanding,
  renderAuthSuccess,
} from "../web/templates.js";

/** Loopback host (remote bind is never allowed). */
export const WRITE_AUTH_LOOPBACK_HOST = "127.0.0.1" as const;
/** Preferred consent ports (previously working range first). */
export const WRITE_AUTH_PORT_START = 3500 as const;
export const WRITE_AUTH_PORT_END = 3505 as const;
/** Dedicated fallback consent port when the preferred range is busy. */
export const WRITE_AUTH_FALLBACK_PORT = 3510 as const;
/** Exact OAuth callback path (part of the registered redirect URI). */
export const WRITE_AUTH_CALLBACK_PATH = "/oauth2callback" as const;
/** Bounded consent window (the server stops itself when it expires). */
export const WRITE_AUTH_DEFAULT_TTL_MS = 12 * 60 * 1000;

export type WriteOAuthClientFactory = (
  redirectUri: string,
) => Promise<OAuth2Client>;

async function defaultWriteOAuthClientFactory(
  redirectUri: string,
): Promise<OAuth2Client> {
  // Reuses the EXISTING OAuth client registration (user-authorized client
  // JSON) for a SEPARATE narrow consent; no new client, no readonly reuse.
  const { client_id, client_secret } = await loadCredentials();
  return new OAuth2Client(client_id, client_secret, redirectUri);
}

interface PendingWriteAuthFlow {
  readonly codeVerifier: string;
  readonly codeChallenge: string;
  readonly state: string;
}

export interface WriteAuthServerOptions {
  readonly createOAuthClient?: WriteOAuthClientFactory;
  readonly tokenPath?: string;
  readonly ttlMs?: number;
}

export interface WriteAuthStartRequest {
  readonly account: string;
  readonly port?: number;
  readonly openBrowser?: boolean;
}

export interface WriteAuthSession {
  readonly account: string;
  readonly port: number;
  readonly landingUrl: string;
  readonly callbackUrl: string;
  readonly expiresAt: number;
}

export class WriteAuthServer {
  private flowOAuthClient: OAuth2Client | null = null;
  private server: http.Server | null = null;
  private readonly activeConnections: Set<import("net").Socket> = new Set();
  private pendingAuthFlow: PendingWriteAuthFlow | null = null;
  private ttlTimer: ReturnType<typeof setTimeout> | null = null;
  private doneResolve: ((ok: boolean) => void) | null = null;
  private doneSettled = false;
  private expiresAt = 0;
  private account = "";
  private readonly tokenPath: string;
  private readonly ttlMs: number;
  private readonly createOAuthClient: WriteOAuthClientFactory;
  public authCompletedSuccessfully = false;

  constructor(options: WriteAuthServerOptions = {}) {
    this.createOAuthClient =
      options.createOAuthClient ?? defaultWriteOAuthClientFactory;
    this.tokenPath = options.tokenPath ?? getWriteTokenPath();
    this.ttlMs = options.ttlMs ?? WRITE_AUTH_DEFAULT_TTL_MS;
  }

  /**
   * Generates the narrow write authorization URL.
   * Requires PKCE + state pre-generation (single flow, never regenerated
   * mid-flight, so landing-page visits cannot desync the verifier).
   */
  private generateWriteAuthUrl(client: OAuth2Client): string {
    if (this.pendingAuthFlow === null) {
      throw new Error("write consent flow not initialized");
    }
    return client.generateAuthUrl({
      access_type: "offline",
      scope: [...WRITE_SCOPES],
      prompt: "consent",
      code_challenge_method: CodeChallengeMethod.S256,
      code_challenge: this.pendingAuthFlow.codeChallenge,
      state: this.pendingAuthFlow.state,
    });
  }

  private async preparePkceAndState(client: OAuth2Client): Promise<void> {
    const { codeVerifier, codeChallenge } =
      await client.generateCodeVerifierAsync();
    if (!codeChallenge) {
      throw new Error("write consent PKCE unavailable");
    }
    this.pendingAuthFlow = {
      codeVerifier,
      codeChallenge,
      state: crypto.randomBytes(32).toString("hex"),
    };
  }

  private async sendErrorPage(
    res: http.ServerResponse,
    statusCode: number,
    errorMessage: string,
  ): Promise<void> {
    const errorHtml = await renderAuthError({ errorMessage });
    res.writeHead(statusCode, { "Content-Type": "text/html; charset=utf-8" });
    res.end(errorHtml);
  }

  private createServer(): http.Server {
    const server = http.createServer(async (req, res) => {
      const url = new URL(req.url || "/", `http://${WRITE_AUTH_LOOPBACK_HOST}`);

      if (url.pathname === "/styles.css") {
        const css = await loadWebFile("styles.css");
        res.writeHead(200, { "Content-Type": "text/css; charset=utf-8" });
        res.end(css);
      } else if (url.pathname === "/") {
        try {
          if (this.flowOAuthClient === null || this.pendingAuthFlow === null) {
            throw new Error("write consent flow not ready");
          }
          const authUrl = this.generateWriteAuthUrl(this.flowOAuthClient);
          const landingHtml = await renderAuthLanding({
            accountId: this.account,
            authUrl,
          });
          res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
          res.end(landingHtml);
        } catch {
          await this.sendErrorPage(
            res,
            500,
            "Consent flow not ready. Please restart the consent step.",
          );
        }
      } else if (url.pathname === WRITE_AUTH_CALLBACK_PATH) {
        const code = url.searchParams.get("code");
        const returnedState = url.searchParams.get("state");
        if (this.pendingAuthFlow === null) {
          process.stderr.write(
            "write-auth: callback rejected: no pending flow (expired or already used)\n",
          );
          await this.sendErrorPage(
            res,
            403,
            "This consent link already expired or was already used. Please restart the consent step.",
          );
          return;
        }
        if (code === null || code.length === 0) {
          await this.sendErrorPage(res, 400, "Authorization code missing");
          return;
        }
        if (returnedState === null || returnedState !== this.pendingAuthFlow.state) {
          process.stderr.write(
            "write-auth: callback rejected: invalid state parameter\n",
          );
          await this.sendErrorPage(
            res,
            403,
            "Invalid state parameter. Please restart the consent step.",
          );
          return;
        }
        if (this.flowOAuthClient === null) {
          await this.sendErrorPage(
            res,
            500,
            "Consent flow not properly initiated.",
          );
          return;
        }
        const verifier = this.pendingAuthFlow.codeVerifier;
        try {
          const { tokens } = await this.flowOAuthClient.getToken({
            code,
            codeVerifier: verifier,
          });
          // Single-use: consume BEFORE persist so replays always fail.
          this.pendingAuthFlow = null;
          // Exact-grant validation (broad/readonly grants throw here and
          // persist nothing).
          await saveWriteCredentials(this.account, tokens, this.tokenPath);
          this.authCompletedSuccessfully = true;
          const successHtml = await renderAuthSuccess({
            accountId: this.account,
          });
          res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
          res.end(successHtml);
          process.stderr.write(
            "write-auth: narrow write grant stored for the prepared account\n",
          );
          setTimeout(() => {
            void this.stop().then(() => this.settleDone(true));
          }, 2000);
        } catch {
          this.pendingAuthFlow = null;
          this.authCompletedSuccessfully = false;
          process.stderr.write(
            "write-auth: grant exchange or scope check failed\n",
          );
          await this.sendErrorPage(
            res,
            500,
            "Consent could not be completed. Please restart the consent step.",
          );
        }
      } else {
        res.writeHead(404, { "Content-Type": "text/plain" });
        res.end("Not Found");
      }
    });

    server.on("connection", (socket) => {
      this.activeConnections.add(socket);
      socket.on("close", () => {
        this.activeConnections.delete(socket);
      });
    });

    return server;
  }

  /**
   * Start the loopback consent server. `port` selects the EXACT port
   * (`0` means an OS-assigned ephemeral port for tests only); otherwise the
   * preferred range is scanned, then the dedicated fallback. The redirect
   * URI always matches the ACTUAL bound port. Returns null when no port or
   * no OAuth client is available. Never prints the state-bearing Google
   * URL: only the local landing URL is shown.
   */
  async start(request: WriteAuthStartRequest): Promise<WriteAuthSession | null> {
    let account: string;
    try {
      account = validateAccountId(request.account);
    } catch {
      return null;
    }
    if (this.server !== null) {
      await this.stop();
    }
    const port = await this.startServerOnAvailablePort(request.port);
    if (port === null) {
      return null;
    }
    const redirectUri = `http://${WRITE_AUTH_LOOPBACK_HOST}:${port}${WRITE_AUTH_CALLBACK_PATH}`;
    let flowClient: OAuth2Client;
    try {
      flowClient = await this.createOAuthClient(redirectUri);
    } catch {
      await this.stop();
      return null;
    }
    this.flowOAuthClient = flowClient;
    try {
      await this.preparePkceAndState(flowClient);
    } catch {
      await this.stop();
      return null;
    }
    this.account = account;
    this.authCompletedSuccessfully = false;
    this.doneSettled = false;
    this.doneResolve = null;
    this.expiresAt = Date.now() + this.ttlMs;
    this.ttlTimer = setTimeout(() => {
      process.stderr.write(
        "write-auth: consent window expired without approval\n",
      );
      void this.stop().then(() => this.settleDone(false));
    }, this.ttlMs);
    const landingUrl = `http://${WRITE_AUTH_LOOPBACK_HOST}:${port}/`;
    process.stderr.write(`write-auth: narrow write consent ready at ${landingUrl}\n`);
    const ttlMinutes = Math.max(1, Math.round(this.ttlMs / 60000));
    process.stderr.write(
      `write-auth: window closes in about ${ttlMinutes} minute(s); no secrets are printed here\n`,
    );
    if (request.openBrowser === true) {
      try {
        await open(landingUrl);
      } catch {
        process.stderr.write(
          "write-auth: could not open a browser automatically\n",
        );
      }
    }
    return {
      account,
      port,
      landingUrl,
      callbackUrl: redirectUri,
      expiresAt: this.expiresAt,
    };
  }

  private async startServerOnAvailablePort(
    exactPort?: number,
  ): Promise<number | null> {
    const candidates =
      exactPort !== undefined
        ? [exactPort]
        : [
            ...Array.from(
              { length: WRITE_AUTH_PORT_END - WRITE_AUTH_PORT_START + 1 },
              (_, index) => WRITE_AUTH_PORT_START + index,
            ),
            WRITE_AUTH_FALLBACK_PORT,
          ];
    for (const wanted of candidates) {
      try {
        const actual = await new Promise<number>((resolve, reject) => {
          const candidate = this.createServer();
          candidate.on("error", (err: NodeJS.ErrnoException) => {
            if (err.code === "EADDRINUSE") {
              candidate.close(() => reject(err));
            } else {
              reject(err);
            }
          });
          candidate.listen(wanted, WRITE_AUTH_LOOPBACK_HOST, () => {
            this.server = candidate;
            const address = candidate.address();
            if (typeof address === "object" && address !== null) {
              resolve(address.port);
            } else {
              resolve(wanted);
            }
          });
        });
        return actual;
      } catch (error: unknown) {
        if (
          error instanceof Error &&
          "code" in error &&
          (error as NodeJS.ErrnoException).code === "EADDRINUSE"
        ) {
          continue;
        }
        return null;
      }
    }
    return null;
  }

  public getRunningPort(): number | null {
    if (this.server !== null) {
      const address = this.server.address();
      if (typeof address === "object" && address !== null) {
        return address.port;
      }
    }
    return null;
  }

  public getExpiresAt(): number {
    return this.expiresAt;
  }

  /** Settle the completion promise (first settlement wins). */
  private settleDone(ok: boolean): void {
    if (this.doneSettled) {
      return;
    }
    this.doneSettled = true;
    const resolve = this.doneResolve;
    this.doneResolve = null;
    resolve?.(ok);
  }

  /**
   * Wait until the flow completes (user consent stored) or the bounded
   * window closes (expiry, stop, or cancel). Never resolves with secrets.
   */
  waitForDone(): Promise<boolean> {
    if (this.doneSettled) {
      return Promise.resolve(this.authCompletedSuccessfully);
    }
    return new Promise<boolean>((resolve) => {
      this.doneResolve = resolve;
    });
  }

  /** Owner-initiated cancel (e.g. SIGINT): stop without recording consent. */
  async cancel(): Promise<void> {
    await this.stop();
    this.settleDone(false);
  }

  async stop(): Promise<void> {
    if (this.ttlTimer !== null) {
      clearTimeout(this.ttlTimer);
      this.ttlTimer = null;
    }
    this.pendingAuthFlow = null;
    return new Promise((resolve, reject) => {
      if (this.server !== null) {
        for (const connection of this.activeConnections) {
          connection.destroy();
        }
        this.activeConnections.clear();
        const timeout = setTimeout(() => {
          this.server = null;
          resolve();
        }, 2000);
        this.server.close((err) => {
          clearTimeout(timeout);
          if (err) {
            reject(err);
          } else {
            this.server = null;
            resolve();
          }
        });
      } else {
        resolve();
      }
    });
  }
}
