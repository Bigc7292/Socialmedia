import assert from "node:assert/strict";
import { test } from "node:test";
import { connectedAccountRef, createSocial } from "@opencoredev/social-sdk";
import { connectFacebook, type Terminal } from "../src/connect.js";
import { facebookPage } from "../src/facebook.js";

const page = connectedAccountRef({
  backend: "brand-facebook",
  platform: "facebook",
  accountId: "1001",
});

function recordingFetch(respond: (url: URL, form: FormData | undefined) => Response) {
  const calls: { url: URL; form: FormData | undefined }[] = [];

  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const form = init?.body instanceof FormData ? init.body : undefined;

    calls.push({ url, form });

    return respond(url, form);
  };

  return { calls, fetcher };
}

function pageClient(fetcher: typeof fetch) {
  return createSocial({
    backends: {
      "brand-facebook": facebookPage({
        backend: "brand-facebook",
        pageId: "1001",
        accessToken: "page-token",
        graphVersion: "v25.0",
        fetch: fetcher,
        clock: () => new Date("2026-09-26T12:00:00.000Z"),
      }),
    },
  });
}

test("a text post goes to the Page feed and links to the new post", async () => {
  const { calls, fetcher } = recordingFetch(() => Response.json({ id: "1001_2002" }));

  const result = await pageClient(fetcher).posts.publish({
    targets: [{ account: page }],
    content: { text: "Dark mode is live" },
  });

  const outcome = result.outcomes[0];

  assert.equal(calls[0]?.url.href, "https://graph.facebook.com/v25.0/1001/feed");
  assert.equal(calls[0]?.form?.get("message"), "Dark mode is live");
  assert.equal(calls[0]?.form?.get("access_token"), "page-token");
  assert.equal(outcome?.state, "published");
  assert.equal(outcome?.state === "published" && outcome.url, "https://www.facebook.com/1001_2002");
});

test("a photo URL goes to /photos with the text as its caption", async () => {
  const { calls, fetcher } = recordingFetch(() =>
    Response.json({ id: "3003", post_id: "1001_4004" }),
  );

  const result = await pageClient(fetcher).posts.publish({
    targets: [{ account: page }],
    content: {
      text: "New feature",
      media: [{ kind: "image", source: { kind: "https-url", url: "https://example.com/a.png" } }],
    },
  });

  assert.equal(calls[0]?.url.pathname, "/v25.0/1001/photos");
  assert.equal(calls[0]?.form?.get("url"), "https://example.com/a.png");
  assert.equal(calls[0]?.form?.get("caption"), "New feature");
  assert.equal(
    result.outcomes[0]?.state === "published" && result.outcomes[0].post.postId,
    "1001_4004",
  );
});

test("a video is reported as processing, not published", async () => {
  const { calls, fetcher } = recordingFetch(() => Response.json({ id: "5005" }));

  const result = await pageClient(fetcher).posts.publish({
    targets: [{ account: page }],
    content: {
      text: "Demo",
      media: [
        { kind: "video", source: { kind: "https-url", url: "https://example.com/demo.mp4" } },
      ],
    },
  });

  assert.equal(calls[0]?.url.origin, "https://graph-video.facebook.com");
  assert.equal(calls[0]?.form?.get("file_url"), "https://example.com/demo.mp4");
  assert.equal(result.outcomes[0]?.state, "processing");
});

test("an expired Page token asks for a reconnect and several media items are rejected up front", async () => {
  const { fetcher } = recordingFetch(() =>
    Response.json({ error: { message: "Session has expired", code: 190 } }, { status: 400 }),
  );

  const social = pageClient(fetcher);

  const result = await social.posts.publish({
    targets: [{ account: page }],
    content: { text: "Hi" },
  });

  const outcome = result.outcomes[0];

  assert.equal(outcome?.state === "failed" && outcome.retryDisposition.kind, "after-reconnect");

  const preparation = social.posts.prepare({
    targets: [{ account: page }],
    content: {
      text: "Two photos",
      media: [
        { kind: "image", source: { kind: "https-url", url: "https://example.com/a.png" } },
        { kind: "image", source: { kind: "https-url", url: "https://example.com/b.png" } },
      ],
    },
  });

  assert.equal(preparation.ok, false);
});

test("connecting a Page swaps a user token for the Page's own token", async () => {
  const { calls, fetcher } = recordingFetch((url) => {
    if (url.pathname === "/v25.0/oauth/access_token")
      return Response.json({ access_token: "long-user" });

    if (url.pathname === "/v25.0/me/accounts")
      return Response.json({
        data: [
          { id: "1001", name: "StoneSight AI", access_token: "page-1001" },
          { id: "1002", name: "Discount Hunter AI", access_token: "page-1002" },
        ],
      });

    return new Response("unexpected", { status: 500 });
  });

  const terminal: Terminal = { log: () => undefined, ask: async () => "" };

  const account = {
    id: "brand-facebook",
    brandId: "brand",
    label: "Brand",
    platform: "facebook" as const,
  };

  await assert.rejects(
    connectFacebook(
      account,
      { FACEBOOK_APP_ID: "app", FACEBOOK_APP_SECRET: "secret" },
      terminal,
      undefined,
      "short-user",
      fetcher,
    ),
    /Several accounts are available/,
  );

  const credential = await connectFacebook(
    account,
    { FACEBOOK_APP_ID: "app", FACEBOOK_APP_SECRET: "secret" },
    terminal,
    "Discount Hunter AI",
    "short-user",
    fetcher,
  );

  assert.equal(calls[0]?.url.searchParams.get("grant_type"), "fb_exchange_token");
  assert.equal(calls[0]?.url.searchParams.get("fb_exchange_token"), "short-user");
  assert.equal(credential.accountId, "1002");
  assert.equal(credential.token.accessToken, "page-1002");
  assert.equal(credential.token.expiresAt, undefined);
});
