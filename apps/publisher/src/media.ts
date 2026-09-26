import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename, extname } from "node:path";
import type { MediaAttachment } from "@opencoredev/social-sdk";
import type { PublisherPlatform } from "./config.js";

export type MediaKind = "image" | "video";

export interface MediaRequest {
  readonly kind: MediaKind;
  /** A local file path or a public https URL. */
  readonly location: string;
}

/** One media item in the two forms platforms accept: uploaded bytes or a public URL. */
export interface ResolvedMedia {
  readonly request: MediaRequest;
  readonly upload?: MediaAttachment;
  readonly publicUrl?: MediaAttachment;
}

/** These platforms fetch media from a public https URL instead of accepting an upload. */
const urlOnlyPlatforms: ReadonlySet<PublisherPlatform> = new Set([
  "instagram",
  "threads",
  "tiktok",
]);

const mimeTypes: ReadonlyMap<string, string> = new Map([
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".gif", "image/gif"],
  [".webp", "image/webp"],
  [".mp4", "video/mp4"],
  [".mov", "video/quicktime"],
]);

const maxDownloadBytes = 512 * 1024 * 1024;

export function isPublicUrl(location: string): boolean {
  return location.startsWith("https://");
}

function mimeTypeFor(location: string): string | undefined {
  const path = isPublicUrl(location) ? new URL(location).pathname : location;

  return mimeTypes.get(extname(path).toLowerCase());
}

function uploadAttachment(
  request: MediaRequest,
  bytes: Uint8Array,
  mimeType: string,
): MediaAttachment {
  const blob = new Blob([new Uint8Array(bytes)], { type: mimeType });
  const fingerprint = createHash("sha256").update(bytes).digest("hex");

  const name = isPublicUrl(request.location)
    ? basename(new URL(request.location).pathname)
    : basename(request.location);

  return {
    kind: request.kind,
    source: { kind: "blob", blob, fingerprint },
    mimeType,
    filename: name,
    byteSize: blob.size,
  };
}

async function download(url: string, fetcher: typeof fetch): Promise<Uint8Array> {
  const response = await fetcher(url);

  if (!response.ok) throw new Error(`Could not download ${url} (${response.status})`);
  const bytes = new Uint8Array(await response.arrayBuffer());

  if (bytes.byteLength > maxDownloadBytes) throw new Error(`${url} is larger than 512 MiB`);

  return bytes;
}

/**
 * Load each media item once. A local file becomes an upload. A public URL is
 * kept for URL-only platforms and downloaded when an upload platform needs it.
 */
export async function resolveMedia(
  requests: readonly MediaRequest[],
  platforms: ReadonlySet<PublisherPlatform>,
  fetcher: typeof fetch = fetch,
): Promise<readonly ResolvedMedia[]> {
  const needsUpload = [...platforms].some((platform) => !urlOnlyPlatforms.has(platform));
  const resolved: ResolvedMedia[] = [];

  for (const request of requests) {
    const mimeType = mimeTypeFor(request.location);

    if (mimeType === undefined)
      throw new Error(
        `Unsupported media type for ${request.location} (use png, jpg, gif, webp, mp4 or mov)`,
      );

    if (request.location.startsWith("http://"))
      throw new Error(`Media URLs must use https: ${request.location}`);

    if (!isPublicUrl(request.location)) {
      const bytes = new Uint8Array(await readFile(request.location));

      resolved.push({ request, upload: uploadAttachment(request, bytes, mimeType) });
      continue;
    }

    const publicUrl: MediaAttachment = {
      kind: request.kind,
      source: { kind: "https-url", url: request.location },
      mimeType,
    };

    resolved.push(
      needsUpload
        ? {
            request,
            publicUrl,
            upload: uploadAttachment(request, await download(request.location, fetcher), mimeType),
          }
        : { request, publicUrl },
    );
  }

  return resolved;
}

export type MediaChoice =
  | { readonly ok: true; readonly media: readonly MediaAttachment[] }
  | { readonly ok: false; readonly reason: string };

/** Pick the form of each media item that a platform accepts. */
export function mediaFor(
  platform: PublisherPlatform,
  media: readonly ResolvedMedia[],
): MediaChoice {
  const urlOnly = urlOnlyPlatforms.has(platform);
  const picked: MediaAttachment[] = [];

  for (const item of media) {
    const attachment = urlOnly ? item.publicUrl : item.upload;

    if (attachment === undefined)
      return {
        ok: false,
        reason: `${platform} needs media as a public https URL, not a local file (${item.request.location})`,
      };
    picked.push(attachment);
  }

  return { ok: true, media: picked };
}
