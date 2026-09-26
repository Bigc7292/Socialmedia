import type { OAuthProviderOptions } from "@opencoredev/social-sdk/server";
import type { OAuthPlatform } from "./credentials.js";

/** Environment variable names for each platform's developer app. */
export const appEnvironment: Readonly<
  Record<OAuthPlatform, { readonly id: string; readonly secret: string }>
> = {
  x: { id: "X_CLIENT_ID", secret: "X_CLIENT_SECRET" },
  linkedin: { id: "LINKEDIN_CLIENT_ID", secret: "LINKEDIN_CLIENT_SECRET" },
  threads: { id: "THREADS_APP_ID", secret: "THREADS_APP_SECRET" },
  instagram: { id: "INSTAGRAM_APP_ID", secret: "INSTAGRAM_APP_SECRET" },
  facebook: { id: "FACEBOOK_APP_ID", secret: "FACEBOOK_APP_SECRET" },
  tiktok: { id: "TIKTOK_CLIENT_KEY", secret: "TIKTOK_CLIENT_SECRET" },
  youtube: { id: "GOOGLE_CLIENT_ID", secret: "GOOGLE_CLIENT_SECRET" },
};

export type Environment = Readonly<Record<string, string | undefined>>;

/** LinkedIn requires an explicit monthly API version (YYYYMM). */
export function linkedInApiVersion(env: Environment): string {
  return env["LINKEDIN_API_VERSION"] ?? "202609";
}

/** Graph API version for Facebook Page calls. */
export function facebookGraphVersion(env: Environment): string {
  return env["FACEBOOK_GRAPH_VERSION"] ?? "v25.0";
}

export function redirectUri(env: Environment): string {
  return env["OAUTH_REDIRECT_URI"] ?? "http://localhost:8787/callback";
}

/** API versions the platform adapters are pinned to. */
export interface ApiVersions {
  readonly linkedInApiVersion: string;
  readonly facebookGraphVersion: string;
}

export function backendVersions(env: Environment): ApiVersions {
  return {
    linkedInApiVersion: linkedInApiVersion(env),
    facebookGraphVersion: facebookGraphVersion(env),
  };
}

/** OAuth client settings for connecting and refreshing one platform's accounts. */
export function oauthOptions(platform: OAuthPlatform, env: Environment): OAuthProviderOptions {
  const names = appEnvironment[platform];
  const clientId = env[names.id]?.trim();
  const clientSecret = env[names.secret]?.trim();

  if (!clientId)
    throw new Error(`Set ${names.id} (and usually ${names.secret}) in apps/publisher/.env`);
  const base = { clientId, redirectUri: redirectUri(env) };
  const withSecret = clientSecret ? { ...base, clientSecret } : base;

  if (platform === "linkedin")
    return { ...withSecret, linkedinApiVersion: linkedInApiVersion(env) };

  return withSecret;
}
