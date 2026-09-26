import {
  connectedAccountRef,
  platformPostRef,
  type AccountRecord,
  type ConnectedAccountRef,
  type DeliveryOutcome,
  type PreparationIssue,
  type PreparedPublishTarget,
  type SocialAdapter,
} from "@opencoredev/social-sdk";
import { isNumber, isRecord, isString, parseJson, type JsonInput } from "./guards.js";

/**
 * Facebook Page publishing through the Graph API. The SDK reaches Facebook
 * only through paid managed backends, so this adapter covers the free,
 * direct route: a Page access token with `pages_manage_posts`.
 */
export interface FacebookPageOptions {
  /** SDK backend name (the account id in brands.json). */
  readonly backend: string;
  readonly pageId: string;
  readonly accessToken: string;
  readonly graphVersion: string;
  readonly fetch?: typeof fetch;
  readonly clock?: () => Date;
}

const expiredTokenCode = 190;

const rateLimitCodes: ReadonlySet<number> = new Set([4, 17, 32, 613]);

interface GraphError {
  readonly status: number;
  readonly code: number | undefined;
  readonly message: string;
}

async function readBody(response: Response): Promise<JsonInput> {
  const text = await response.text();

  try {
    return parseJson(text);
  } catch {
    return null;
  }
}

function graphError(status: number, body: JsonInput): GraphError {
  const error = isRecord(body) ? body["error"] : undefined;
  const code = isRecord(error) ? error["code"] : undefined;
  const message = isRecord(error) ? error["message"] : undefined;

  return {
    status,
    code: isNumber(code) ? code : undefined,
    message: isString(message) ? message : `Facebook returned HTTP ${status}`,
  };
}

function issue(target: PreparedPublishTarget, code: string, message: string): PreparationIssue {
  return { code, message, severity: "error", targetIndex: target.targetIndex };
}

export function facebookPage(options: FacebookPageOptions): SocialAdapter<unknown> {
  const fetcher = options.fetch ?? fetch;
  const clock = options.clock ?? (() => new Date());
  const graph = `https://graph.facebook.com/${options.graphVersion}`;
  const videoGraph = `https://graph-video.facebook.com/${options.graphVersion}`;

  const ownRef = connectedAccountRef({
    backend: options.backend,
    platform: "facebook",
    accountId: options.pageId,
  });

  if (!/^v\d+\.\d+$/.test(options.graphVersion))
    throw new Error(`Facebook Graph API version "${options.graphVersion}" should look like v25.0`);

  if (!/^\d+$/.test(options.pageId)) throw new Error("A Facebook Page id is numeric");

  const isOwn = (ref: ConnectedAccountRef) =>
    ref.backend === options.backend &&
    ref.platform === "facebook" &&
    ref.accountId === options.pageId;

  async function readPage(): Promise<AccountRecord> {
    const url = new URL(`${graph}/${options.pageId}`);

    url.searchParams.set("fields", "id,name");

    const response = await fetcher(url, {
      headers: { authorization: `Bearer ${options.accessToken}` },
    });

    const body = await readBody(response);

    if (!response.ok) {
      const error = graphError(response.status, body);

      if (error.code === expiredTokenCode)
        return { ref: ownRef, displayName: options.pageId, status: "reconnect-required" };
      throw new Error(`Facebook Page check failed: ${error.message}`);
    }

    const name = isRecord(body) ? body["name"] : undefined;

    return {
      ref: ownRef,
      displayName: isString(name) ? name : options.pageId,
      status: "connected",
    };
  }

  function prepareTarget(target: PreparedPublishTarget): readonly PreparationIssue[] {
    const issues: PreparationIssue[] = [];
    const media = target.content.media ?? [];

    if (!isOwn(target.account))
      issues.push(
        issue(target, "facebook.account", "This target belongs to a different Facebook Page"),
      );

    if (media.length > 1)
      issues.push(
        issue(target, "facebook.media", "Facebook posts here carry one image or one video"),
      );

    for (const item of media) {
      if (item.kind === "document")
        issues.push(
          issue(target, "facebook.media", "Facebook Pages do not accept document posts here"),
        );

      if (item.source.kind !== "https-url" && item.source.kind !== "blob")
        issues.push(issue(target, "facebook.media", "Use a public https URL or a local file"));
    }

    if (target.schedule !== undefined)
      issues.push(
        issue(target, "facebook.schedule", "Scheduled Facebook posts are not supported here"),
      );

    if (target.replyTo !== undefined)
      issues.push(issue(target, "facebook.reply", "Facebook replies are not supported here"));

    return issues;
  }

  function outcomeBase(target: PreparedPublishTarget) {
    return {
      targetIndex: target.targetIndex,
      account: target.account,
      observedAt: clock().toISOString(),
    };
  }

  function failed(target: PreparedPublishTarget, error: GraphError): DeliveryOutcome {
    const base = outcomeBase(target);

    if (error.code === expiredTokenCode)
      return {
        ...base,
        state: "failed",
        code: "reconnect_required",
        message: error.message,
        retryDisposition: { kind: "after-reconnect" },
      };

    if (error.code !== undefined && rateLimitCodes.has(error.code))
      return {
        ...base,
        state: "failed",
        code: "rate_limited",
        message: error.message,
        retryDisposition: { kind: "after-delay", delayMs: 60_000 },
      };

    // A server error may still have created the post, so check the Page first.
    if (error.status >= 500)
      return {
        ...base,
        state: "unknown",
        reason: "ambiguous-submission",
        diagnostic: error.message,
      };

    return {
      ...base,
      state: "failed",
      code: "upstream_failure",
      message: error.message,
      retryDisposition: { kind: "never" },
    };
  }

  async function publishTarget(
    target: PreparedPublishTarget,
    context: { readonly signal?: AbortSignal },
  ): Promise<DeliveryOutcome> {
    const media = target.content.media?.[0];
    const text = target.content.text;
    const form = new FormData();
    let endpoint = `${graph}/${options.pageId}/feed`;

    if (media === undefined) {
      if (text !== undefined) form.set("message", text);
    } else if (media.kind === "video") {
      endpoint = `${videoGraph}/${options.pageId}/videos`;

      if (text !== undefined) form.set("description", text);
    } else {
      endpoint = `${graph}/${options.pageId}/photos`;

      if (text !== undefined) form.set("caption", text);
    }

    if (media?.source.kind === "https-url")
      form.set(media.kind === "video" ? "file_url" : "url", media.source.url);
    else if (media?.source.kind === "blob")
      form.set("source", media.source.blob, media.filename ?? "upload");
    form.set("access_token", options.accessToken);
    let response: Response;

    try {
      response = await fetcher(
        endpoint,
        context.signal === undefined
          ? { method: "POST", body: form }
          : { method: "POST", body: form, signal: context.signal },
      );
    } catch (error) {
      return {
        ...outcomeBase(target),
        state: "unknown",
        reason: "ambiguous-submission",
        diagnostic: `The request did not finish (${error instanceof Error ? error.message : "network error"}); check the Page before posting again`,
      };
    }

    const body = await readBody(response);

    if (!response.ok) return failed(target, graphError(response.status, body));
    const id = isRecord(body) ? body["id"] : undefined;
    const postId = isRecord(body) ? body["post_id"] : undefined;

    // Videos return only a video id while Facebook processes the upload.
    if (media?.kind === "video" || !isString(postId ?? id))
      return { ...outcomeBase(target), state: "processing" };
    const publishedId = isString(postId) ? postId : String(id);

    return {
      ...outcomeBase(target),
      state: "published",
      post: platformPostRef({
        backend: options.backend,
        platform: "facebook",
        accountId: options.pageId,
        postId: publishedId,
      }),
      url: `https://www.facebook.com/${publishedId}`,
    };
  }

  return {
    id: "facebook-page",
    capabilities: {
      schemaVersion: 1,
      backend: "facebook-page",
      apiRevision: options.graphVersion,
      runtime: ["node", "bun"],
      capabilities: [
        { operation: "accounts.read", platform: "facebook", availability: "available" },
        {
          operation: "posts.publish",
          platform: "facebook",
          availability: "available",
          formats: ["text", "image", "video"],
          requiredScopes: ["pages_manage_posts", "pages_read_engagement", "pages_show_list"],
        },
      ],
    },
    accounts: {
      async list() {
        return { items: [await readPage()] };
      },
      async get(ref) {
        if (!isOwn(ref)) throw new Error("This account belongs to a different Facebook Page");

        return readPage();
      },
    },
    posts: { prepareTarget, publishTarget },
  };
}
