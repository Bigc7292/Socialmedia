import { randomUUID } from "node:crypto";
import { appendFile, mkdir } from "node:fs/promises";
import { stdin, stdout } from "node:process";
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import { createSocial, type SocialAdapter } from "@opencoredev/social-sdk";
import { liveAccess } from "./access.js";
import {
  accountBackend,
  offlineFetch,
  placeholderAccess,
  type AccountBackend,
} from "./backends.js";
import {
  allAccounts,
  findAccount,
  isPublisherPlatform,
  loadPublisherConfig,
  publisherPlatforms,
  selectAccounts,
  type AccountConfig,
  type PublisherPlatform,
} from "./config.js";
import {
  connectBluesky,
  connectFacebook,
  connectOAuth,
  manualCredential,
  type Terminal,
} from "./connect.js";
import { CredentialFile, type StoredCredential } from "./credentials.js";
import { isString } from "./guards.js";
import { resolveMedia, type MediaRequest } from "./media.js";
import { backendVersions } from "./platform-apps.js";
import {
  checkPlan,
  planTargets,
  publishPlan,
  uploadMediaFirst,
  withPlaceholderUploads,
  type PostDraft,
  type SkippedTarget,
} from "./publish.js";
import { expiresInMs } from "./tokens.js";

const brandsPath = process.env["PUBLISHER_BRANDS_FILE"] ?? "brands.json";

const dataDir = process.env["PUBLISHER_DATA_DIR"] ?? ".data";

const help = `Post to every account of up to four apps with one command.

Usage (run inside apps/publisher):
  bun run social accounts [--verify]
  bun run social connect <account-id> [options]
  bun run social post --brand <id|all> --text "..." [options]

connect options:
  --pick <id>                 choose one of several accounts the login returned
  --access-token <token>      store a token made in the platform's dashboard instead of logging in
  --user-token <token>        Facebook: start from a Graph API Explorer user token, skip the browser
  --account-id <id>           the platform account id that token belongs to
  --expires-in-days <n>       how long that token lasts (Threads/Instagram: 60)
  --handle <handle>           Bluesky handle, e.g. myapp.bsky.social
  --app-password <password>   Bluesky app password (asked for when omitted)
  --service <url>             Bluesky server, default https://bsky.social

post options:
  --brand <id>                brand id from brands.json, repeatable, or "all"
  --text <text>               the post text
  --<platform>-text <text>    replace the text on one platform, e.g. --x-text
  --image <path|url>          attach an image (repeatable)
  --video <path|url>          attach a video
  --title <title>             YouTube/TikTok title (defaults to the first line of text)
  --only <platform|account>   limit to platforms or account ids (repeatable)
  --dry-run                   validate everything without contacting any social network
  --yes                       skip the confirmation prompt
`;

function terminal(): Terminal & { close(): void } {
  const lines = createInterface({ input: stdin, output: stdout });

  return {
    log: (message) => console.log(message),
    ask: (question) => lines.question(question),
    close: () => lines.close(),
  };
}

function describeLogin(credential: StoredCredential | undefined, now: Date): string {
  if (credential === undefined) return "not connected";

  if (credential.kind === "bluesky-app-password") return `${credential.displayName} (app password)`;
  const remaining = expiresInMs(credential, now);

  if (remaining === undefined) return credential.displayName;

  if (remaining <= 0)
    return `${credential.displayName} (token expired${credential.token.refreshToken ? ", will refresh" : " — reconnect"})`;
  const hours = Math.floor(remaining / 3_600_000);

  return `${credential.displayName} (token ${hours >= 48 ? `${Math.floor(hours / 24)}d` : `${hours}h`} left)`;
}

async function listAccounts(verify: boolean): Promise<void> {
  const config = await loadPublisherConfig(brandsPath);
  const credentials = await CredentialFile.open(`${dataDir}/credentials.json`);
  const now = new Date();

  for (const brand of config.brands) {
    console.log(`\n${brand.name} (${brand.id})`);

    for (const account of brand.accounts) {
      let status = describeLogin(credentials.get(account.id), now);

      if (verify && credentials.get(account.id) !== undefined)
        try {
          const backend = accountBackend(
            account,
            await liveAccess(account, credentials, process.env, now),
            backendVersions(process.env),
          );

          const social = createSocial({ backends: { [account.id]: backend.adapter } });
          const record = await social.accounts.get(backend.ref);

          status = `${record.displayName}: ${record.status}`;
        } catch (error) {
          status = `check failed: ${error instanceof Error ? error.message : String(error)}`;
        }

      console.log(`  ${account.id.padEnd(24)} ${account.platform.padEnd(10)} ${status}`);
    }
  }
}

async function connect(argv: readonly string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args: [...argv],
    allowPositionals: true,
    options: {
      pick: { type: "string" },
      "access-token": { type: "string" },
      "account-id": { type: "string" },
      "user-token": { type: "string" },
      "expires-in-days": { type: "string" },
      handle: { type: "string" },
      "app-password": { type: "string" },
      service: { type: "string" },
    },
  });

  const accountId = positionals[0];

  if (accountId === undefined) throw new Error("Usage: bun run social connect <account-id>");
  const config = await loadPublisherConfig(brandsPath);
  const account = findAccount(config, accountId);
  const credentials = await CredentialFile.open(`${dataDir}/credentials.json`);
  const io = terminal();

  try {
    let credential: StoredCredential;

    if (account.platform === "bluesky") {
      const handle =
        values.handle ?? (await io.ask("Bluesky handle (e.g. myapp.bsky.social): ")).trim();

      const appPassword = values["app-password"] ?? (await io.ask("Bluesky app password: ")).trim();

      credential = await connectBluesky(
        handle,
        appPassword,
        values.service ?? "https://bsky.social",
        new Date(),
      );
    } else if (values["access-token"] !== undefined) {
      const platformAccountId = values["account-id"];

      if (platformAccountId === undefined)
        throw new Error("--access-token also needs --account-id (the platform's user or page id)");
      const days = values["expires-in-days"];

      credential = manualCredential(
        account,
        platformAccountId,
        values["access-token"],
        days === undefined ? undefined : Number(days),
        new Date(),
      );
    } else if (account.platform === "facebook")
      credential = await connectFacebook(
        account,
        process.env,
        io,
        values.pick,
        values["user-token"],
      );
    else credential = await connectOAuth(account, process.env, io, values.pick);
    await credentials.set(account.id, credential);
    console.log(`Connected ${account.id} as ${credential.displayName}.`);
  } finally {
    io.close();
  }
}

function textOverrides(
  values: Readonly<Record<string, string | boolean | string[] | boolean[] | undefined>>,
): ReadonlyMap<PublisherPlatform, string> {
  const overrides = new Map<PublisherPlatform, string>();

  for (const platform of publisherPlatforms) {
    const value = values[`${platform}-text`];

    if (isString(value)) overrides.set(platform, value);
  }

  return overrides;
}

async function buildBackends(
  accounts: readonly AccountConfig[],
  dryRun: boolean,
): Promise<{
  readonly backends: readonly AccountBackend[];
  readonly skipped: readonly SkippedTarget[];
}> {
  const credentials = await CredentialFile.open(`${dataDir}/credentials.json`);

  const settings = dryRun
    ? { ...backendVersions(process.env), fetch: offlineFetch }
    : backendVersions(process.env);

  const backends: AccountBackend[] = [];
  const skipped: SkippedTarget[] = [];
  const now = new Date();

  for (const account of accounts)
    try {
      const stored = credentials.get(account.id);

      const knownId =
        stored === undefined ? undefined : stored.kind === "oauth" ? stored.accountId : stored.did;

      const access = dryRun
        ? placeholderAccess(account, knownId)
        : await liveAccess(account, credentials, process.env, now);

      backends.push(accountBackend(account, access, settings));
    } catch (error) {
      skipped.push({ account, reason: error instanceof Error ? error.message : String(error) });
    }

  return { backends, skipped };
}

async function post(argv: readonly string[]): Promise<void> {
  const platformTextOptions = Object.fromEntries(
    publisherPlatforms.map((platform) => [`${platform}-text`, { type: "string" as const }]),
  );

  const { values } = parseArgs({
    args: [...argv],
    options: {
      ...platformTextOptions,
      brand: { type: "string", multiple: true },
      text: { type: "string" },
      image: { type: "string", multiple: true },
      video: { type: "string" },
      title: { type: "string" },
      only: { type: "string", multiple: true },
      "dry-run": { type: "boolean" },
      yes: { type: "boolean" },
    },
  });

  const brandIds = (values.brand ?? []).flatMap((item) => item.split(","));
  const only = (values.only ?? []).flatMap((item) => item.split(","));
  const text = values.text;
  const dryRun = values["dry-run"] === true;

  if (brandIds.length === 0 || text === undefined || text.trim() === "")
    throw new Error('post needs --brand <id|all> and --text "..."');
  const config = await loadPublisherConfig(brandsPath);
  const accounts = selectAccounts(config, brandIds, only);

  for (const filter of only)
    if (
      !isPublisherPlatform(filter) &&
      !allAccounts(config).some((account) => account.id === filter)
    )
      throw new Error(`--only ${filter} is neither a platform nor an account id`);

  if (accounts.length === 0) throw new Error("No accounts match that brand and --only filter");

  const mediaRequests: MediaRequest[] = [
    ...(values.image ?? []).map((location) => ({ kind: "image" as const, location })),
    ...(values.video === undefined ? [] : [{ kind: "video" as const, location: values.video }]),
  ];

  const { backends, skipped: unavailable } = await buildBackends(accounts, dryRun);

  const media = await resolveMedia(
    mediaRequests,
    new Set(backends.map(({ account }) => account.platform)),
  );

  const draft: PostDraft = {
    text,
    textByPlatform: textOverrides(values),
    media,
    title: values.title,
  };

  const registry: Record<string, SocialAdapter<unknown>> = {};

  for (const backend of backends) registry[backend.account.id] = backend.adapter;
  const plan = planTargets(backends, draft);
  const idempotencyKey = randomUUID();

  const social = backends.length === 0 ? undefined : createSocial({ backends: registry });

  const checked =
    social === undefined
      ? { ready: [], skipped: [], warnings: [] }
      : checkPlan(social, withPlaceholderUploads(plan, draft), draft, idempotencyKey);

  const skipped = [...unavailable, ...checked.skipped];

  for (const item of skipped) console.log(`  skip  ${item.account.id.padEnd(24)} ${item.reason}`);

  for (const warning of checked.warnings) console.log(`  note  ${warning}`);

  for (const item of checked.ready)
    console.log(`  ready ${item.backend.account.id.padEnd(24)} ${item.backend.account.platform}`);

  if (social === undefined || checked.ready.length === 0)
    throw new Error("Nothing to post: every account was skipped");

  if (dryRun) {
    console.log(
      `\nDry run: ${checked.ready.length} account(s) would receive this post. Nothing was sent.`,
    );

    return;
  }

  if (values.yes !== true) {
    const io = terminal();
    const answer = await io.ask(`\nPost to ${checked.ready.length} account(s) now? [y/N] `);

    io.close();

    if (answer.trim().toLowerCase() !== "y") {
      console.log("Cancelled. Nothing was posted.");

      return;
    }
  }

  const uploads = await uploadMediaFirst(social, checked.ready, plan, draft);

  for (const item of uploads.skipped) {
    skipped.push(item);
    console.log(`  skip  ${item.account.id.padEnd(24)} ${item.reason}`);
  }

  const results = await publishPlan(social, uploads.ready, draft, idempotencyKey);

  for (const result of results)
    console.log(
      `  ${result.state.padEnd(10)} ${result.accountId.padEnd(24)} ${result.url ?? result.detail ?? result.postId ?? ""}`,
    );
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  await appendFile(
    `${dataDir}/history.jsonl`,
    `${JSON.stringify({ at: new Date().toISOString(), idempotencyKey, text, results, skipped: skipped.map((item) => ({ accountId: item.account.id, reason: item.reason })) })}\n`,
  );
}

async function main(argv: readonly string[]): Promise<void> {
  const [command, ...rest] = argv;

  switch (command) {
    case "accounts":
      return listAccounts(rest.includes("--verify"));
    case "connect":
      return connect(rest);
    case "post":
      return post(rest);
    default:
      console.log(help);
  }
}

try {
  await main(process.argv.slice(2));
} catch (error) {
  console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
