import { readFile } from "node:fs/promises";
import {
  isBoolean,
  isList,
  isRecord,
  isString,
  optionalString,
  parseJson,
  requiredString,
  type JsonInput,
  type JsonRecord,
} from "./guards.js";

export const publisherPlatforms = [
  "x",
  "bluesky",
  "linkedin",
  "threads",
  "instagram",
  "tiktok",
  "youtube",
] as const;

export type PublisherPlatform = (typeof publisherPlatforms)[number];

export type TikTokPrivacy =
  | "SELF_ONLY"
  | "MUTUAL_FOLLOW_FRIENDS"
  | "FOLLOWER_OF_CREATOR"
  | "PUBLIC_TO_EVERYONE";

export type YouTubeVisibility = "private" | "unlisted" | "public";

interface AccountBase {
  /** Unique across every brand. Also the SDK backend name for this account. */
  readonly id: string;
  readonly brandId: string;
  readonly label: string;
}

export type AccountConfig =
  | (AccountBase & { readonly platform: "bluesky" })
  | (AccountBase & { readonly platform: "x" | "threads" | "instagram" })
  | (AccountBase & {
      readonly platform: "linkedin";
      /** Post as a LinkedIn company page instead of the personal profile. */
      readonly organization: boolean;
    })
  | (AccountBase & {
      readonly platform: "youtube";
      readonly visibility: YouTubeVisibility;
      readonly madeForKids: boolean;
    })
  | (AccountBase & {
      readonly platform: "tiktok";
      readonly privacy: TikTokPrivacy;
      readonly verifiedMediaOrigins: readonly string[];
    });

export interface BrandConfig {
  readonly id: string;
  readonly name: string;
  readonly accounts: readonly AccountConfig[];
}

export interface PublisherConfig {
  readonly brands: readonly BrandConfig[];
}

const idPattern = /^[a-z0-9][a-z0-9-]{0,62}$/;

const tiktokPrivacyLevels: readonly TikTokPrivacy[] = [
  "SELF_ONLY",
  "MUTUAL_FOLLOW_FRIENDS",
  "FOLLOWER_OF_CREATOR",
  "PUBLIC_TO_EVERYONE",
];

const youtubeVisibilities: readonly YouTubeVisibility[] = ["private", "unlisted", "public"];

export function isPublisherPlatform(value: string): value is PublisherPlatform {
  return publisherPlatforms.some((platform) => platform === value);
}

function isTikTokPrivacy(value: string): value is TikTokPrivacy {
  return tiktokPrivacyLevels.some((level) => level === value);
}

function isYouTubeVisibility(value: string): value is YouTubeVisibility {
  return youtubeVisibilities.some((visibility) => visibility === value);
}

function checkId(id: string, where: string): string {
  if (!idPattern.test(id))
    throw new Error(`${where}: id "${id}" must use lowercase letters, digits and dashes`);

  return id;
}

function optionalBoolean(record: JsonRecord, key: string, where: string): boolean | undefined {
  const value = record[key];

  if (value === undefined) return undefined;

  if (!isBoolean(value)) throw new Error(`${where}: "${key}" must be true or false`);

  return value;
}

function parseAccount(value: JsonInput, brandId: string, where: string): AccountConfig {
  if (!isRecord(value)) throw new Error(`${where}: each account must be an object`);
  const id = checkId(requiredString(value, "id", where), where);
  const platform = requiredString(value, "platform", where);
  const label = optionalString(value, "label", where) ?? id;
  const base = { id, brandId, label };

  if (!isPublisherPlatform(platform))
    throw new Error(
      `${where}: platform "${platform}" is not one of ${publisherPlatforms.join(", ")}`,
    );

  switch (platform) {
    case "linkedin":
      return {
        ...base,
        platform,
        organization: optionalBoolean(value, "organization", where) ?? false,
      };
    case "youtube": {
      const visibility = optionalString(value, "visibility", where) ?? "public";

      if (!isYouTubeVisibility(visibility))
        throw new Error(`${where}: visibility must be one of ${youtubeVisibilities.join(", ")}`);

      return {
        ...base,
        platform,
        visibility,
        madeForKids: optionalBoolean(value, "madeForKids", where) ?? false,
      };
    }

    case "tiktok": {
      const privacy = optionalString(value, "privacy", where) ?? "SELF_ONLY";

      if (!isTikTokPrivacy(privacy))
        throw new Error(`${where}: privacy must be one of ${tiktokPrivacyLevels.join(", ")}`);
      const origins = value["verifiedMediaOrigins"] ?? [];

      if (!isList(origins) || !origins.every(isString))
        throw new Error(`${where}: verifiedMediaOrigins must be a list of https origins`);

      return { ...base, platform, privacy, verifiedMediaOrigins: origins.filter(isString) };
    }

    default:
      return { ...base, platform };
  }
}

function parseBrand(value: JsonInput, index: number): BrandConfig {
  const where = `brands[${index}]`;

  if (!isRecord(value)) throw new Error(`${where} must be an object`);
  const id = checkId(requiredString(value, "id", where), where);
  const name = optionalString(value, "name", where) ?? id;
  const accounts = value["accounts"];

  if (!isList(accounts)) throw new Error(`${where}: "accounts" must be a list`);

  return {
    id,
    name,
    accounts: accounts.map((account, accountIndex) =>
      parseAccount(account, id, `${where}.accounts[${accountIndex}]`),
    ),
  };
}

/** Validate a brands file. Account ids must be unique across every brand. */
export function parsePublisherConfig(text: string): PublisherConfig {
  const root = parseJson(text);

  if (!isRecord(root) || !isList(root["brands"]))
    throw new Error('The brands file must contain {"brands": [...]}');
  const brands = root["brands"].map(parseBrand);
  const seen = new Set<string>();

  for (const brand of brands) {
    if (seen.has(`brand:${brand.id}`)) throw new Error(`Brand id "${brand.id}" is used twice`);
    seen.add(`brand:${brand.id}`);

    for (const account of brand.accounts) {
      if (seen.has(account.id)) throw new Error(`Account id "${account.id}" is used twice`);
      seen.add(account.id);
    }
  }

  return { brands };
}

export async function loadPublisherConfig(path: string): Promise<PublisherConfig> {
  let text: string;

  try {
    text = await readFile(path, "utf8");
  } catch {
    throw new Error(
      `Could not read ${path}. Copy brands.example.json to brands.json and edit it for your apps.`,
    );
  }

  return parsePublisherConfig(text);
}

export function allAccounts(config: PublisherConfig): readonly AccountConfig[] {
  return config.brands.flatMap((brand) => brand.accounts);
}

export function findAccount(config: PublisherConfig, id: string): AccountConfig {
  const account = allAccounts(config).find((item) => item.id === id);

  if (account === undefined) throw new Error(`No account "${id}" in the brands file`);

  return account;
}

/**
 * Pick accounts for a post. `brandIds` of ["all"] selects every brand; `only`
 * narrows by platform or account id when it is not empty.
 */
export function selectAccounts(
  config: PublisherConfig,
  brandIds: readonly string[],
  only: readonly string[],
): readonly AccountConfig[] {
  const everyBrand = brandIds.includes("all");

  for (const id of brandIds)
    if (id !== "all" && !config.brands.some((brand) => brand.id === id))
      throw new Error(`No brand "${id}" in the brands file`);

  return config.brands
    .filter((brand) => everyBrand || brandIds.includes(brand.id))
    .flatMap((brand) =>
      brand.accounts.filter(
        (account) =>
          only.length === 0 || only.includes(account.platform) || only.includes(account.id),
      ),
    );
}
