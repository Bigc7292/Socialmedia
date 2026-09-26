import {
  connectedAccountRef,
  type ConnectedAccountRef,
  type SocialAdapter,
} from "@opencoredev/social-sdk";
import { bluesky } from "@opencoredev/social-sdk/bluesky";
import { instagram } from "@opencoredev/social-sdk/instagram";
import { linkedin } from "@opencoredev/social-sdk/linkedin";
import { threads } from "@opencoredev/social-sdk/threads";
import { tiktok } from "@opencoredev/social-sdk/tiktok";
import { x } from "@opencoredev/social-sdk/x";
import { youtube } from "@opencoredev/social-sdk/youtube";
import type { AccountConfig } from "./config.js";
import { facebookPage } from "./facebook.js";
import type { ApiVersions } from "./platform-apps.js";

/** Live credentials for one account, already refreshed or logged in. */
export type AccountAccess =
  | {
      readonly platform: "bluesky";
      readonly service: string;
      readonly did: string;
      readonly accessJwt: string;
    }
  | {
      readonly platform: Exclude<AccountConfig["platform"], "bluesky">;
      readonly accountId: string;
      readonly accessToken: string;
    };

export interface AccountBackend {
  readonly account: AccountConfig;
  readonly adapter: SocialAdapter<unknown>;
  readonly ref: ConnectedAccountRef;
}

export interface BackendSettings extends ApiVersions {
  readonly fetch?: typeof fetch;
}

function mismatch(account: AccountConfig, access: AccountAccess): Error {
  return new Error(
    `Account ${account.id} is configured as ${account.platform} but its credential is for ${access.platform}`,
  );
}

/**
 * Build the SDK adapter for one account. The account id doubles as the SDK
 * backend name, so every account (even two on the same platform) is its own
 * backend with its own credentials.
 */
export function accountBackend(
  account: AccountConfig,
  access: AccountAccess,
  settings: BackendSettings,
): AccountBackend {
  const backend = account.id;
  const fetchOption = settings.fetch === undefined ? {} : { fetch: settings.fetch };

  const ref = (accountId: string) =>
    connectedAccountRef({ backend, platform: account.platform, accountId });

  if (access.platform === "bluesky") {
    if (account.platform !== "bluesky") throw mismatch(account, access);

    return {
      account,
      ref: ref(access.did),
      adapter: bluesky({
        backend,
        auth: { service: access.service, did: access.did, accessJwt: access.accessJwt },
        ...fetchOption,
      }),
    };
  }

  const { accountId, accessToken } = access;

  if (account.platform !== access.platform) throw mismatch(account, access);

  switch (account.platform) {
    case "x":
      return {
        account,
        ref: ref(accountId),
        adapter: x({ auth: { userId: accountId, accessToken }, ...fetchOption }),
      };
    case "threads":
      return {
        account,
        ref: ref(accountId),
        adapter: threads({ backend, auth: { userId: accountId, accessToken }, ...fetchOption }),
      };
    case "instagram":
      return {
        account,
        ref: ref(accountId),
        adapter: instagram({ auth: { accountId, accessToken }, ...fetchOption }),
      };
    case "youtube":
      return {
        account,
        ref: ref(accountId),
        adapter: youtube({ auth: { channelId: accountId, accessToken }, ...fetchOption }),
      };
    case "facebook":
      return {
        account,
        ref: ref(accountId),
        adapter: facebookPage({
          backend,
          pageId: accountId,
          accessToken,
          graphVersion: settings.facebookGraphVersion,
          ...fetchOption,
        }),
      };
    case "tiktok":
      return {
        account,
        ref: ref(accountId),
        adapter: tiktok({
          auth: { openId: accountId, accessToken },
          verifiedMediaOrigins: account.verifiedMediaOrigins,
          ...fetchOption,
        }),
      };
    case "linkedin": {
      if (!accountId.startsWith("urn:li:person:") && !accountId.startsWith("urn:li:organization:"))
        throw new Error(`Account ${account.id} has an invalid LinkedIn author URN`);

      const author: `urn:li:person:${string}` | `urn:li:organization:${string}` =
        accountId.startsWith("urn:li:person:")
          ? `urn:li:person:${accountId.slice("urn:li:person:".length)}`
          : `urn:li:organization:${accountId.slice("urn:li:organization:".length)}`;

      return {
        account,
        ref: ref(author),
        adapter: linkedin({
          auth: { accessToken, author },
          apiVersion: settings.linkedInApiVersion,
          ...fetchOption,
        }),
      };
    }

    default:
      throw mismatch(account, access);
  }
}

/** Stand-in credentials for a dry run. No request is made with them. */
export function placeholderAccess(account: AccountConfig, knownAccountId?: string): AccountAccess {
  if (account.platform === "bluesky")
    return {
      platform: "bluesky",
      service: "https://bsky.social",
      did: knownAccountId ?? "did:plc:dryrun",
      accessJwt: "dry-run",
    };

  // Each platform checks the id's format, so the stand-in has to look real.
  const fallbacks: Partial<Record<AccountConfig["platform"], string>> = {
    linkedin: "urn:li:person:dryrun",
    facebook: "1",
  };

  const fallback = fallbacks[account.platform] ?? `dryrun-${account.id}`;

  return {
    platform: account.platform,
    accountId: knownAccountId ?? fallback,
    accessToken: "dry-run",
  };
}

/** A fetch that refuses every request, used to keep dry runs offline. */
export const offlineFetch: typeof fetch = async (input) => {
  const target = input instanceof Request ? input.url : String(input);

  throw new Error(`Dry run: blocked a network request to ${new URL(target).origin}`);
};
