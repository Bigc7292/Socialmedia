import type { AccountAccess } from "./backends.js";
import { createBlueskySession } from "./bluesky-session.js";
import type { AccountConfig } from "./config.js";
import type { CredentialFile } from "./credentials.js";
import type { Environment } from "./platform-apps.js";
import { freshCredential } from "./tokens.js";

/**
 * Load an account's stored login, log in or refresh as needed, and save any
 * rotated token before it is used.
 */
export async function liveAccess(
  account: AccountConfig,
  credentials: CredentialFile,
  env: Environment,
  now: Date,
  fetcher?: typeof fetch,
): Promise<AccountAccess> {
  const stored = credentials.get(account.id);

  if (stored === undefined)
    throw new Error(`not connected yet (run: bun run social connect ${account.id})`);

  if (stored.platform !== account.platform)
    throw new Error(`stored login is for ${stored.platform}; reconnect it as ${account.platform}`);

  if (stored.kind === "bluesky-app-password") {
    const session = await createBlueskySession(
      stored.service,
      stored.identifier,
      stored.appPassword,
      fetcher,
    );

    return {
      platform: "bluesky",
      service: stored.service,
      did: session.did,
      accessJwt: session.accessJwt,
    };
  }

  const fresh = await freshCredential(stored, env, now, fetcher);

  if (fresh !== stored) await credentials.set(account.id, fresh);

  return {
    platform: fresh.platform,
    accountId: fresh.accountId,
    accessToken: fresh.token.accessToken,
  };
}
