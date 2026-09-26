import type {
  DeliveryOutcome,
  MediaAttachment,
  MediaRef,
  PreparationIssue,
  PublishRequest,
  PublishTarget,
  SocialClient,
} from "@opencoredev/social-sdk";
import type { AccountBackend } from "./backends.js";
import type { AccountConfig, PublisherPlatform } from "./config.js";
import { mediaFor, type ResolvedMedia } from "./media.js";

export interface PostDraft {
  readonly text: string;
  /** Replaces `text` on one platform, for example a shorter X version. */
  readonly textByPlatform: ReadonlyMap<PublisherPlatform, string>;
  readonly media: readonly ResolvedMedia[];
  /** YouTube video title and TikTok caption title. Defaults to the first line of text. */
  readonly title: string | undefined;
}

export interface PlannedTarget {
  readonly backend: AccountBackend;
  readonly target: PublishTarget;
}

export interface SkippedTarget {
  readonly account: AccountConfig;
  readonly reason: string;
}

export interface TargetPlan {
  readonly planned: readonly PlannedTarget[];
  readonly skipped: readonly SkippedTarget[];
}

function defaultTitle(draft: PostDraft): string {
  const firstLine = draft.title ?? draft.text.split("\n", 1)[0] ?? "";

  return firstLine.trim().slice(0, 100) || "New video";
}

function hasVideo(media: readonly MediaAttachment[]): boolean {
  return media.some((item) => item.kind === "video");
}

/** Platform rules that are worth explaining before the SDK rejects a target. */
function missingRequirement(
  platform: PublisherPlatform,
  media: readonly MediaAttachment[],
): string | undefined {
  if (platform === "youtube" && (media.length !== 1 || !hasVideo(media)))
    return "YouTube posts need exactly one video (--video)";

  if (platform === "tiktok" && media.length === 0) return "TikTok posts need a video or images";

  if (platform === "instagram" && media.length === 0)
    return "Instagram posts need an image or video";

  if (platform === "bluesky" && hasVideo(media))
    return "Bluesky video upload is not supported by the SDK yet (images work)";

  return undefined;
}

function targetFor(
  backend: AccountBackend,
  draft: PostDraft,
  media: readonly MediaAttachment[],
): PublishTarget {
  const { account, ref } = backend;
  const override = draft.textByPlatform.get(account.platform);
  const content = override === undefined ? { media } : { media, text: override };

  switch (account.platform) {
    case "youtube":
      return {
        account: ref,
        content,
        options: {
          title: defaultTitle(draft),
          visibility: account.visibility,
          madeForKids: account.madeForKids,
        },
      };
    case "tiktok":
      // Running the post command for this account is the creator's consent to publish it.
      return {
        account: ref,
        content,
        options: { privacy: account.privacy, consentGiven: true, title: defaultTitle(draft) },
      };
    default:
      return { account: ref, content };
  }
}

/** Decide what each account receives, and which accounts cannot take this post. */
export function planTargets(backends: readonly AccountBackend[], draft: PostDraft): TargetPlan {
  const planned: PlannedTarget[] = [];
  const skipped: SkippedTarget[] = [];

  for (const backend of backends) {
    const { account } = backend;
    const choice = mediaFor(account.platform, draft.media);

    if (!choice.ok) {
      skipped.push({ account, reason: choice.reason });
      continue;
    }

    const missing = missingRequirement(account.platform, choice.media);

    if (missing !== undefined) {
      skipped.push({ account, reason: missing });
      continue;
    }

    planned.push({ backend, target: targetFor(backend, draft, choice.media) });
  }

  return { planned, skipped };
}

/** LinkedIn only publishes media it has already received through `media.upload`. */
function uploadsFirst(planned: PlannedTarget): boolean {
  return (
    planned.backend.account.platform === "linkedin" &&
    (planned.target.content?.media?.length ?? 0) > 0
  );
}

function withMedia(planned: PlannedTarget, media: readonly MediaAttachment[]): PlannedTarget {
  return {
    ...planned,
    target: { ...planned.target, content: { ...planned.target.content, media } },
  };
}

function uploadedAttachment(item: MediaAttachment, ref: MediaRef, title: string): MediaAttachment {
  const source = { kind: "media-ref" as const, ref };

  // LinkedIn uses a video's caption as its title.
  return item.kind === "video"
    ? { kind: item.kind, source, caption: title }
    : { kind: item.kind, source };
}

/**
 * Stand in for LinkedIn's uploaded media during a dry run, so the rest of the
 * post can still be validated without uploading anything.
 */
export function withPlaceholderUploads(plan: TargetPlan, draft: PostDraft): TargetPlan {
  const planned = plan.planned.map((item) => {
    if (!uploadsFirst(item)) return item;

    const media = (item.target.content?.media ?? []).map((attachment, index) =>
      uploadedAttachment(
        attachment,
        {
          kind: "media",
          version: 1,
          backend: item.backend.ref.backend,
          platform: item.backend.ref.platform,
          accountId: item.backend.ref.accountId,
          mediaId: `urn:li:${attachment.kind}:dryrun${index}`,
        },
        defaultTitle(draft),
      ),
    );

    return withMedia(item, media);
  });

  return { planned, skipped: plan.skipped };
}

/** Upload LinkedIn media for real and point each target at the uploaded copies. */
export async function uploadMediaFirst(
  social: SocialClient,
  ready: readonly PlannedTarget[],
  original: TargetPlan,
  draft: PostDraft,
): Promise<{
  readonly ready: readonly PlannedTarget[];
  readonly skipped: readonly SkippedTarget[];
}> {
  const sources = new Map(original.planned.map((item) => [item.backend.account.id, item]));
  const uploaded: PlannedTarget[] = [];
  const skipped: SkippedTarget[] = [];

  for (const item of ready) {
    const source = sources.get(item.backend.account.id) ?? item;

    if (!uploadsFirst(source)) {
      uploaded.push(item);
      continue;
    }

    try {
      const media: MediaAttachment[] = [];

      for (const attachment of source.target.content?.media ?? [])
        media.push(
          uploadedAttachment(
            attachment,
            await social.media.upload(attachment, item.backend.ref),
            defaultTitle(draft),
          ),
        );
      uploaded.push(withMedia(item, media));
    } catch (error) {
      skipped.push({
        account: item.backend.account,
        reason: `media upload failed: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }

  return { ready: uploaded, skipped };
}

function buildRequest(
  targets: readonly PlannedTarget[],
  draft: PostDraft,
  idempotencyKey: string,
): PublishRequest {
  return {
    targets: targets.map((item) => item.target),
    content: { text: draft.text },
    idempotencyKey,
  };
}

function describeIssues(issues: readonly PreparationIssue[]): string {
  return issues.map((issue) => issue.message).join("; ");
}

export interface CheckedPlan {
  readonly ready: readonly PlannedTarget[];
  readonly skipped: readonly SkippedTarget[];
  readonly warnings: readonly string[];
}

/**
 * Validate the post locally against each platform's rules. Targets the SDK
 * rejects are moved to `skipped` so one bad target does not block the rest.
 */
export function checkPlan(
  social: SocialClient,
  plan: TargetPlan,
  draft: PostDraft,
  idempotencyKey: string,
): CheckedPlan {
  let ready = [...plan.planned];
  const skipped = [...plan.skipped];
  const warnings: string[] = [];

  while (ready.length > 0) {
    const preparation = social.posts.prepare(buildRequest(ready, draft, idempotencyKey));
    const errors = preparation.issues.filter((issue) => issue.severity === "error");

    for (const issue of preparation.issues)
      if (issue.severity === "warning") warnings.push(issue.message);

    if (errors.length === 0) break;
    const failedIndexes = new Set(errors.map((issue) => issue.targetIndex));

    if (failedIndexes.has(undefined))
      throw new Error(`The post is invalid: ${describeIssues(errors)}`);
    const remaining: PlannedTarget[] = [];

    for (const [index, item] of ready.entries()) {
      if (!failedIndexes.has(index)) {
        remaining.push(item);
        continue;
      }

      const own = errors.filter((issue) => issue.targetIndex === index);

      skipped.push({ account: item.backend.account, reason: describeIssues(own) });
    }

    ready = remaining;
  }

  return { ready, skipped, warnings };
}

export interface AccountResult {
  readonly accountId: string;
  readonly platform: PublisherPlatform;
  readonly state: DeliveryOutcome["state"];
  readonly url?: string;
  readonly postId?: string;
  readonly detail?: string;
}

function describeOutcome(
  outcome: DeliveryOutcome,
): Pick<AccountResult, "url" | "postId" | "detail"> {
  switch (outcome.state) {
    case "published":
      return outcome.url === undefined
        ? { postId: outcome.post.postId }
        : { postId: outcome.post.postId, url: outcome.url };
    case "failed":
      return { detail: `${outcome.code}: ${outcome.message}` };
    case "not-submitted":
      return { detail: outcome.reason };
    case "unknown":
      return { detail: `${outcome.reason} — check the account before retrying` };
    case "processing":
    case "accepted":
      return { detail: "the platform is still processing it" };
    default:
      return {};
  }
}

/**
 * LinkedIn refuses to post a video that is still processing. No post exists
 * in that case, so trying the same target again later is safe.
 */
function stillProcessing(outcome: DeliveryOutcome): number | undefined {
  if (
    outcome.state !== "failed" ||
    outcome.code !== "media_error" ||
    outcome.retryDisposition.kind !== "after-delay"
  )
    return undefined;

  return Math.min(Math.max(outcome.retryDisposition.delayMs, 1_000), 10_000);
}

const maxProcessingRetries = 12;

export async function publishPlan(
  social: SocialClient,
  ready: readonly PlannedTarget[],
  draft: PostDraft,
  idempotencyKey: string,
  wait: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
): Promise<readonly AccountResult[]> {
  if (ready.length === 0) return [];
  const accounts = new Map(ready.map((item) => [item.backend.account.id, item.backend.account]));
  const targets = new Map(ready.map((item) => [item.backend.account.id, item]));
  const finalOutcomes = new Map<string, DeliveryOutcome>();
  let pending = ready;

  for (let attempt = 0; pending.length > 0; attempt++) {
    const key = attempt === 0 ? idempotencyKey : `${idempotencyKey}-retry${attempt}`;
    const result = await social.posts.publish(buildRequest(pending, draft, key));
    const again: PlannedTarget[] = [];
    let delayMs = 0;

    for (const outcome of result.outcomes) {
      finalOutcomes.set(outcome.account.backend, outcome);
      const delay = stillProcessing(outcome);
      const target = targets.get(outcome.account.backend);

      if (delay !== undefined && target !== undefined && attempt < maxProcessingRetries) {
        again.push(target);
        delayMs = Math.max(delayMs, delay);
      }
    }

    if (again.length > 0) await wait(delayMs);
    pending = again;
  }

  return [...finalOutcomes.values()].map((outcome) => {
    const account = accounts.get(outcome.account.backend);

    if (account === undefined)
      throw new Error(`The SDK returned an outcome for unknown backend ${outcome.account.backend}`);

    return {
      accountId: account.id,
      platform: account.platform,
      state: outcome.state,
      ...describeOutcome(outcome),
    };
  });
}
