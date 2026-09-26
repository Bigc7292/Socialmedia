import { refreshOAuthToken } from "@opencoredev/social-sdk/server";
import type { OAuthCredential } from "./credentials.js";
import { oauthOptions, type Environment } from "./platform-apps.js";

const minute = 60_000;

const day = 24 * 60 * minute;

/**
 * Threads and Instagram hand out 60-day tokens that can only be extended while
 * still valid, so refresh them a week early. The others expire in hours and
 * carry a refresh token.
 */
function refreshWindowMs(credential: OAuthCredential): number {
  return credential.platform === "threads" || credential.platform === "instagram"
    ? 7 * day
    : 5 * minute;
}

export function expiresInMs(credential: OAuthCredential, now: Date): number | undefined {
  const expiresAt = credential.token.expiresAt;

  return expiresAt === undefined ? undefined : Date.parse(expiresAt) - now.getTime();
}

export function needsRefresh(credential: OAuthCredential, now: Date): boolean {
  const remaining = expiresInMs(credential, now);

  return remaining !== undefined && remaining < refreshWindowMs(credential);
}

/** Return a usable credential, refreshing it when it is close to expiry. */
export async function freshCredential(
  credential: OAuthCredential,
  env: Environment,
  now: Date,
  fetcher?: typeof fetch,
): Promise<OAuthCredential> {
  if (!needsRefresh(credential, now)) return credential;
  const remaining = expiresInMs(credential, now) ?? 0;
  const platform = credential.platform;

  // Page tokens made from a long-lived user token do not expire; there is nothing to refresh.
  if (platform === "facebook") {
    if (remaining > 0) return credential;
    throw new Error(
      `The Facebook Page token for ${credential.displayName} has expired. Run connect again.`,
    );
  }

  const renewable =
    credential.token.refreshToken !== undefined ||
    ((credential.platform === "threads" || credential.platform === "instagram") && remaining > 0);

  if (!renewable) {
    if (remaining > 0) return credential;
    throw new Error(
      `The ${credential.platform} login for ${credential.displayName} has expired. Run connect again.`,
    );
  }

  const options = oauthOptions(platform, env);

  const token = await refreshOAuthToken(
    platform,
    fetcher === undefined ? options : { ...options, fetch: fetcher },
    credential.token,
  );

  return { ...credential, token, updatedAt: now.toISOString() };
}
