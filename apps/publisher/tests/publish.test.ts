import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  connectedAccountRef,
  createSocial,
  platformPostRef,
  type BackendRegistry,
  type DeliveryOutcome,
  type SocialAdapter,
} from "@opencoredev/social-sdk";
import {
  accountBackend,
  offlineFetch,
  placeholderAccess,
  type AccountBackend,
} from "../src/backends.js";
import type { AccountConfig } from "../src/config.js";
import { resolveMedia } from "../src/media.js";
import {
  checkPlan,
  planTargets,
  publishPlan,
  uploadMediaFirst,
  withPlaceholderUploads,
  type PostDraft,
} from "../src/publish.js";

const accounts: readonly AccountConfig[] = [
  { id: "app-one-x", brandId: "app-one", label: "X", platform: "x" },
  { id: "app-one-bluesky", brandId: "app-one", label: "Bluesky", platform: "bluesky" },
  { id: "app-one-instagram", brandId: "app-one", label: "Instagram", platform: "instagram" },
  {
    id: "app-one-linkedin",
    brandId: "app-one",
    label: "LinkedIn",
    platform: "linkedin",
    organization: false,
  },
];

function dryRunBackends(): readonly AccountBackend[] {
  return accounts.map((account) =>
    accountBackend(account, placeholderAccess(account), {
      linkedInApiVersion: "202609",
      fetch: offlineFetch,
    }),
  );
}

function registry(backends: readonly AccountBackend[]): BackendRegistry {
  return Object.fromEntries(backends.map((backend) => [backend.account.id, backend.adapter]));
}

function draft(text: string, overrides: [AccountConfig["platform"], string][] = []): PostDraft {
  return { text, textByPlatform: new Map(overrides), media: [], title: undefined };
}

test("a dry run validates against real platform rules and skips only the targets that fail", () => {
  const backends = dryRunBackends();
  const social = createSocial({ backends: registry(backends) });
  const post = draft("Dark mode is here", [["x", "x".repeat(300)]]);

  const checked = checkPlan(
    social,
    withPlaceholderUploads(planTargets(backends, post), post),
    post,
    "key-1",
  );

  assert.deepEqual(
    checked.ready.map((item) => item.backend.account.id),
    ["app-one-bluesky", "app-one-linkedin"],
  );
  assert.deepEqual(checked.skipped.map((item) => item.account.id).sort(), [
    "app-one-instagram",
    "app-one-x",
  ]);
  assert.match(
    checked.skipped.find((item) => item.account.id === "app-one-x")?.reason ?? "",
    /280/,
  );
});

test("LinkedIn images pass a dry run through placeholder uploads", async () => {
  const folder = await mkdtemp(join(tmpdir(), "publisher-"));
  const image = join(folder, "launch.png");

  await writeFile(image, new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]));
  const backends = dryRunBackends();
  const social = createSocial({ backends: registry(backends) });

  const media = await resolveMedia(
    [{ kind: "image", location: image }],
    new Set(["linkedin", "x"]),
  );

  const post: PostDraft = { ...draft("Screenshot attached"), media };

  const checked = checkPlan(
    social,
    withPlaceholderUploads(planTargets(backends, post), post),
    post,
    "key-2",
  );

  assert.ok(checked.ready.some((item) => item.backend.account.id === "app-one-linkedin"));
  assert.match(
    checked.skipped.find((item) => item.account.id === "app-one-instagram")?.reason ?? "",
    /public https URL/,
  );
});

/** A LinkedIn-like adapter: media must be uploaded first, and video takes two checks to process. */
function processingAdapter(backend: string, platform: "linkedin") {
  let publishCalls = 0;
  const uploads: string[] = [];

  const adapter: SocialAdapter<unknown> = {
    id: "processing-fixture",
    capabilities: {
      schemaVersion: 1,
      backend: "processing-fixture",
      apiRevision: "fixture",
      runtime: ["node"],
      capabilities: [
        {
          operation: "posts.publish",
          platform,
          availability: "available",
          formats: ["text", "video"],
        },
        { operation: "media.upload", platform, availability: "available" },
      ],
    },
    media: {
      async upload(input, account) {
        uploads.push(input.kind);

        return {
          kind: "media",
          version: 1,
          backend,
          platform,
          accountId: account.accountId,
          mediaId: "urn:li:video:1",
        };
      },
    },
    posts: {
      prepareTarget: (target) =>
        target.content.media?.every((item) => item.source.kind === "media-ref") === false
          ? [
              {
                code: "fixture.media",
                message: "upload first",
                severity: "error",
                targetIndex: target.targetIndex,
              },
            ]
          : [],
      async publishTarget(target): Promise<DeliveryOutcome> {
        publishCalls++;

        const base = {
          targetIndex: target.targetIndex,
          account: target.account,
          observedAt: "2026-09-26T12:00:00.000Z",
        };

        return publishCalls < 3
          ? {
              ...base,
              state: "failed",
              code: "media_error",
              message: "still processing",
              retryDisposition: { kind: "after-delay", delayMs: 5000 },
            }
          : {
              ...base,
              state: "published",
              post: platformPostRef({
                backend,
                platform,
                accountId: target.account.accountId,
                postId: "urn:li:share:9",
              }),
            };
      },
    },
  };

  return { adapter, uploads, publishCalls: () => publishCalls };
}

test("LinkedIn media is uploaded before posting and a processing video is retried until it posts", async () => {
  const account: AccountConfig = accounts[3] ?? assert.fail();
  const fixture = processingAdapter(account.id, "linkedin");

  const backend: AccountBackend = {
    account,
    adapter: fixture.adapter,
    ref: connectedAccountRef({
      backend: account.id,
      platform: "linkedin",
      accountId: "urn:li:person:abc",
    }),
  };

  const social = createSocial({ backends: { [account.id]: fixture.adapter } });
  const folder = await mkdtemp(join(tmpdir(), "publisher-"));
  const video = join(folder, "demo.mp4");

  await writeFile(video, new Uint8Array(1024));
  const media = await resolveMedia([{ kind: "video", location: video }], new Set(["linkedin"]));
  const post: PostDraft = { ...draft("Demo"), media };
  const plan = planTargets([backend], post);
  const checked = checkPlan(social, withPlaceholderUploads(plan, post), post, "key-3");
  const uploaded = await uploadMediaFirst(social, checked.ready, plan, post);
  const waits: number[] = [];

  const results = await publishPlan(social, uploaded.ready, post, "key-3", async (ms) => {
    waits.push(ms);
  });

  assert.deepEqual(fixture.uploads, ["video"]);
  assert.equal(fixture.publishCalls(), 3);
  assert.deepEqual(waits, [5000, 5000]);
  assert.deepEqual(
    results.map((result) => [result.accountId, result.state, result.postId]),
    [["app-one-linkedin", "published", "urn:li:share:9"]],
  );
});
