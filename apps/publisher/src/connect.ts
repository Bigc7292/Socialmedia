import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { connectedAccountRef } from "@opencoredev/social-sdk";
import {
  ConnectionManager,
  MemoryConnectionStore,
  oauthProvider,
  type ConnectionAccount,
  type OAuthProviderOptions,
  type OAuthTokenSet,
} from "@opencoredev/social-sdk/server";
import { createBlueskySession } from "./bluesky-session.js";
import type { AccountConfig } from "./config.js";
import type {
  BlueskyCredential,
  EditableTokenSet,
  OAuthCredential,
  OAuthPlatform,
} from "./credentials.js";
import { isList, isRecord, isString, parseJson, type JsonRecord } from "./guards.js";
import {
  facebookGraphVersion,
  oauthOptions,
  redirectUri,
  type Environment,
} from "./platform-apps.js";

export interface Terminal {
  log(message: string): void;
  ask(question: string): Promise<string>;
}

const linkedInOrganizationScopes = [
  "openid",
  "profile",
  "w_member_social",
  "w_organization_social",
  "rw_organization_admin",
];

const callbackTimeoutMs = 10 * 60_000;

type EditableProviderOptions = {
  -readonly [K in keyof OAuthProviderOptions]: OAuthProviderOptions[K];
};

function isLoopback(url: URL): boolean {
  return url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
}

/** Serve the loopback redirect URI once and resolve with the full callback URL. */
function waitForLoopbackCallback(redirect: URL): Promise<string> {
  return new Promise((resolve, reject) => {
    const server = createServer((request, response) => {
      const received = new URL(request.url ?? "/", redirect.origin);

      if (received.pathname !== redirect.pathname) {
        response.writeHead(404).end();

        return;
      }

      response
        .writeHead(200, { "content-type": "text/plain; charset=utf-8" })
        .end("Account connected. You can close this tab and return to the terminal.");
      clearTimeout(timer);
      server.close();
      resolve(received.href);
    });

    const timer = setTimeout(() => {
      server.close();
      reject(new Error("Timed out waiting for the login redirect"));
    }, callbackTimeoutMs);

    server.on("error", reject);
    server.listen(Number(redirect.port || 80), redirect.hostname.replace(/^\[|\]$/g, ""));
  });
}

async function readCallback(redirect: URL, terminal: Terminal): Promise<string> {
  if (isLoopback(redirect)) return waitForLoopbackCallback(redirect);

  return (
    await terminal.ask("After approving, paste the full URL your browser was sent to:\n> ")
  ).trim();
}

function pickAccount(
  account: AccountConfig,
  discovered: readonly ConnectionAccount[],
  pick: string | undefined,
): ConnectionAccount {
  const choices =
    account.platform === "linkedin"
      ? discovered.filter(({ ref }) =>
          ref.accountId.startsWith(
            account.organization ? "urn:li:organization:" : "urn:li:person:",
          ),
        )
      : discovered;

  const chosen =
    pick === undefined
      ? choices.length === 1
        ? choices[0]
        : undefined
      : choices.find(({ ref, displayName }) => ref.accountId === pick || displayName === pick);

  if (chosen !== undefined) return chosen;

  const listing = choices
    .map(({ ref, displayName }) => `  ${ref.accountId}  (${displayName})`)
    .join("\n");

  throw new Error(
    choices.length === 0
      ? `The login did not return a usable ${account.platform} account for ${account.id}`
      : `Several accounts are available. Re-run with --pick <id>:\n${listing}`,
  );
}

/** Platforms whose login the SDK's `oauthProvider` runs. */
export type SdkOAuthPlatform = Exclude<OAuthPlatform, "facebook">;

/** Run the platform's OAuth login in the browser and return the credential to store. */
export async function connectOAuth(
  account: AccountConfig & { readonly platform: SdkOAuthPlatform },
  env: Environment,
  terminal: Terminal,
  pick: string | undefined,
  fetcher?: typeof fetch,
  now: () => Date = () => new Date(),
): Promise<OAuthCredential> {
  const platform = account.platform;
  const tokens = new Map<string, OAuthTokenSet>();

  const options: EditableProviderOptions = {
    ...oauthOptions(platform, env),
    credentialSink: {
      async save(input) {
        tokens.set(input.account.ref.accountId, input.token);
      },
    },
  };

  if (account.platform === "linkedin" && account.organization)
    options.scopes = linkedInOrganizationScopes;

  if (fetcher !== undefined) options.fetch = fetcher;
  const provider = oauthProvider(platform, options);

  const manager = new ConnectionManager({ store: new MemoryConnectionStore() });
  const redirect = redirectUri(env);
  const allowedRedirectUris = [redirect];
  const identity = { tenantId: "local", principalId: "local" };

  const started = await manager.begin({
    ...identity,
    backend: account.id,
    platforms: [platform],
    redirectUri: redirect,
    allowedRedirectUris,
    provider,
  });

  terminal.log(
    `Open this link, sign in as the ${account.label} account and approve access:\n\n${started.authorizationUrl}\n`,
  );
  const callbackUrl = await readCallback(new URL(redirect), terminal);
  const returnedState = new URL(callbackUrl).searchParams.get("state") ?? "";

  const discovered = await manager.discover({
    ...identity,
    attemptId: started.attempt.id,
    callbackUrl,
    returnedState,
    allowedRedirectUris,
    provider,
  });

  const chosen = pickAccount(account, discovered, pick);
  const token = tokens.get(chosen.ref.accountId);

  if (token === undefined) throw new Error("The login finished without returning a token");

  return {
    kind: "oauth",
    platform,
    accountId: chosen.ref.accountId,
    displayName: chosen.displayName,
    token,
    updatedAt: now().toISOString(),
  };
}

/** Store a token generated in the platform's developer dashboard. */
export function manualCredential(
  account: AccountConfig & { readonly platform: OAuthPlatform },
  accountId: string,
  accessToken: string,
  expiresInDays: number | undefined,
  now: Date,
): OAuthCredential {
  const token: EditableTokenSet = { accessToken };

  if (expiresInDays !== undefined)
    token.expiresAt = new Date(now.getTime() + expiresInDays * 24 * 60 * 60_000).toISOString();

  return {
    kind: "oauth",
    platform: account.platform,
    accountId,
    displayName: account.label,
    token,
    updatedAt: now.toISOString(),
  };
}

/** Verify a Bluesky app password by logging in, then return the credential to store. */
export async function connectBluesky(
  identifier: string,
  appPassword: string,
  service: string,
  now: Date,
  fetcher?: typeof fetch,
): Promise<BlueskyCredential> {
  const session = await createBlueskySession(service, identifier, appPassword, fetcher);

  return {
    kind: "bluesky-app-password",
    platform: "bluesky",
    service,
    identifier,
    appPassword,
    did: session.did,
    displayName: session.handle,
    updatedAt: now.toISOString(),
  };
}

const facebookScopes = "pages_show_list,pages_read_engagement,pages_manage_posts";

/** GET a Graph API object, or throw with Facebook's own error message. */
async function graphGet(url: URL, fetcher: typeof fetch, bearer?: string): Promise<JsonRecord> {
  const response = await fetcher(
    url,
    bearer === undefined ? {} : { headers: { authorization: `Bearer ${bearer}` } },
  );

  const text = await response.text();
  let body: JsonRecord | undefined;

  try {
    const parsed = parseJson(text);

    body = isRecord(parsed) ? parsed : undefined;
  } catch {
    body = undefined;
  }

  const error = body?.["error"];
  const message = isRecord(error) ? error["message"] : undefined;

  if (!response.ok || body === undefined)
    throw new Error(
      `Facebook ${url.pathname} failed (${response.status})${isString(message) ? `: ${message}` : ""}`,
    );

  return body;
}

function tokenFrom(body: JsonRecord, step: string): string {
  const token = body["access_token"];

  if (!isString(token) || token === "") throw new Error(`Facebook ${step} returned no token`);

  return token;
}

/**
 * Connect a Facebook Page: log in (or take a user token from the Graph API
 * Explorer), swap it for a long-lived user token, then take the Page's own
 * token, which does not expire.
 */
export async function connectFacebook(
  account: AccountConfig & { readonly platform: "facebook" },
  env: Environment,
  terminal: Terminal,
  pick: string | undefined,
  userToken: string | undefined,
  fetcher: typeof fetch = fetch,
  now: () => Date = () => new Date(),
): Promise<OAuthCredential> {
  const { clientId, clientSecret } = oauthOptions("facebook", env);

  if (clientSecret === undefined) throw new Error("Set FACEBOOK_APP_SECRET in apps/publisher/.env");
  const version = facebookGraphVersion(env);
  const graph = `https://graph.facebook.com/${version}`;
  let shortToken = userToken;

  if (shortToken === undefined) {
    const redirect = new URL(redirectUri(env));
    const state = randomUUID();
    const authorization = new URL(`https://www.facebook.com/${version}/dialog/oauth`);

    authorization.searchParams.set("client_id", clientId);
    authorization.searchParams.set("redirect_uri", redirect.href);
    authorization.searchParams.set("state", state);
    authorization.searchParams.set("scope", facebookScopes);
    authorization.searchParams.set("response_type", "code");
    terminal.log(
      `Open this link, sign in as an admin of the ${account.label} Page and approve access:\n\n${authorization.href}\n`,
    );
    const callback = new URL(await readCallback(redirect, terminal));

    if (callback.origin !== redirect.origin || callback.pathname !== redirect.pathname)
      throw new Error("That is not the redirect URL configured in OAUTH_REDIRECT_URI");

    if (callback.searchParams.get("state") !== state)
      throw new Error("The login state did not match; start connect again");
    const code = callback.searchParams.get("code");

    if (code === null)
      throw new Error(
        `Facebook did not approve the login: ${callback.searchParams.get("error_description") ?? "no code returned"}`,
      );
    const exchange = new URL(`${graph}/oauth/access_token`);

    exchange.searchParams.set("client_id", clientId);
    exchange.searchParams.set("client_secret", clientSecret);
    exchange.searchParams.set("redirect_uri", redirect.href);
    exchange.searchParams.set("code", code);
    shortToken = tokenFrom(await graphGet(exchange, fetcher), "code exchange");
  }

  const longLived = new URL(`${graph}/oauth/access_token`);

  longLived.searchParams.set("grant_type", "fb_exchange_token");
  longLived.searchParams.set("client_id", clientId);
  longLived.searchParams.set("client_secret", clientSecret);
  longLived.searchParams.set("fb_exchange_token", shortToken);
  const userLongToken = tokenFrom(await graphGet(longLived, fetcher), "long-lived token exchange");
  const pagesUrl = new URL(`${graph}/me/accounts`);

  pagesUrl.searchParams.set("fields", "id,name,access_token");
  const pages = (await graphGet(pagesUrl, fetcher, userLongToken))["data"];

  if (!isList(pages)) throw new Error("Facebook returned no Page list");
  const pageTokens = new Map<string, string>();
  const discovered: ConnectionAccount[] = [];

  for (const page of pages) {
    if (!isRecord(page)) continue;
    const id = page["id"];
    const name = page["name"];
    const token = page["access_token"];

    if (!isString(id) || !isString(token)) continue;
    pageTokens.set(id, token);
    discovered.push({
      ref: connectedAccountRef({ backend: account.id, platform: "facebook", accountId: id }),
      displayName: isString(name) ? name : id,
    });
  }

  const chosen = pickAccount(account, discovered, pick);
  const pageToken = pageTokens.get(chosen.ref.accountId);

  if (pageToken === undefined) throw new Error("Facebook returned no token for that Page");

  return {
    kind: "oauth",
    platform: "facebook",
    accountId: chosen.ref.accountId,
    displayName: chosen.displayName,
    token: { accessToken: pageToken },
    updatedAt: now().toISOString(),
  };
}
