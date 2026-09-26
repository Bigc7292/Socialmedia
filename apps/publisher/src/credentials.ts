import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { OAuthTokenSet } from "@opencoredev/social-sdk/server";
import type { PublisherPlatform } from "./config.js";
import {
  isList,
  isRecord,
  isString,
  optionalString,
  parseJson,
  requiredString,
  type JsonInput,
} from "./guards.js";

export type OAuthPlatform = Exclude<PublisherPlatform, "bluesky">;

export interface OAuthCredential {
  readonly kind: "oauth";
  readonly platform: OAuthPlatform;
  /** X user id, YouTube channel id, LinkedIn author URN, Threads user id, Instagram account id or TikTok open_id. */
  readonly accountId: string;
  readonly displayName: string;
  readonly token: OAuthTokenSet;
  readonly updatedAt: string;
}

export interface BlueskyCredential {
  readonly kind: "bluesky-app-password";
  readonly platform: "bluesky";
  readonly service: string;
  readonly identifier: string;
  readonly appPassword: string;
  readonly did: string;
  readonly displayName: string;
  readonly updatedAt: string;
}

export type StoredCredential = OAuthCredential | BlueskyCredential;

/** An OAuth token set that is still being assembled. */
export type EditableTokenSet = { -readonly [K in keyof OAuthTokenSet]: OAuthTokenSet[K] };

function isOAuthPlatform(value: string): value is OAuthPlatform {
  return ["x", "linkedin", "threads", "instagram", "facebook", "tiktok", "youtube"].includes(value);
}

function decodeToken(value: JsonInput | undefined, where: string): OAuthTokenSet {
  if (!isRecord(value)) throw new Error(`${where}: token must be an object`);
  const refreshToken = optionalString(value, "refreshToken", where);
  const expiresAt = optionalString(value, "expiresAt", where);
  const scopes = value["scopes"];

  if (scopes !== undefined && (!isList(scopes) || !scopes.every(isString)))
    throw new Error(`${where}: scopes must be a list of strings`);

  const token: EditableTokenSet = { accessToken: requiredString(value, "accessToken", where) };

  if (refreshToken !== undefined) token.refreshToken = refreshToken;

  if (expiresAt !== undefined) token.expiresAt = expiresAt;

  if (scopes !== undefined) token.scopes = scopes.filter(isString);

  return token;
}

function decodeCredential(value: JsonInput, where: string): StoredCredential {
  if (!isRecord(value)) throw new Error(`${where} must be an object`);
  const kind = requiredString(value, "kind", where);
  const updatedAt = requiredString(value, "updatedAt", where);
  const displayName = requiredString(value, "displayName", where);

  if (kind === "bluesky-app-password")
    return {
      kind,
      platform: "bluesky",
      service: requiredString(value, "service", where),
      identifier: requiredString(value, "identifier", where),
      appPassword: requiredString(value, "appPassword", where),
      did: requiredString(value, "did", where),
      displayName,
      updatedAt,
    };

  const platform = requiredString(value, "platform", where);

  if (kind !== "oauth" || !isOAuthPlatform(platform))
    throw new Error(`${where}: unknown credential kind "${kind}" for "${platform}"`);

  return {
    kind,
    platform,
    accountId: requiredString(value, "accountId", where),
    displayName,
    token: decodeToken(value["token"], where),
    updatedAt,
  };
}

/**
 * Plaintext JSON file of account credentials, written with owner-only
 * permissions. Keep it out of git and backups you share.
 */
export class CredentialFile {
  readonly #path: string;
  readonly #entries: Map<string, StoredCredential>;

  private constructor(path: string, entries: Map<string, StoredCredential>) {
    this.#path = path;
    this.#entries = entries;
  }

  static async open(path: string): Promise<CredentialFile> {
    let text: string;

    try {
      text = await readFile(path, "utf8");
    } catch {
      return new CredentialFile(path, new Map());
    }

    const root = parseJson(text);

    if (!isRecord(root) || !isRecord(root["accounts"]))
      throw new Error(`${path} is not a credentials file`);
    const entries = new Map<string, StoredCredential>();

    for (const [id, value] of Object.entries(root["accounts"]))
      entries.set(id, decodeCredential(value, `${path}: ${id}`));

    return new CredentialFile(path, entries);
  }

  get(accountId: string): StoredCredential | undefined {
    return this.#entries.get(accountId);
  }

  async set(accountId: string, credential: StoredCredential): Promise<void> {
    this.#entries.set(accountId, credential);
    await this.#save();
  }

  async #save(): Promise<void> {
    await mkdir(dirname(this.#path), { recursive: true, mode: 0o700 });
    const temporary = `${this.#path}.${process.pid}.tmp`;
    const accounts = Object.fromEntries(this.#entries);

    await writeFile(temporary, `${JSON.stringify({ version: 1, accounts }, null, 2)}\n`, {
      mode: 0o600,
    });
    await rename(temporary, this.#path);
    await chmod(this.#path, 0o600);
  }
}
