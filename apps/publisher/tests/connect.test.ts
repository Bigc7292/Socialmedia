import assert from "node:assert/strict";
import { test } from "node:test";
import { connectBluesky, connectOAuth, type Terminal } from "../src/connect.js";

function urlOf(input: string | URL | Request): string {
  return input instanceof Request ? input.url : String(input);
}

test("connecting X runs the OAuth login and returns the discovered account's token", async () => {
  const logged: string[] = [];

  // Stand in for the browser: approve the login and come back with the code and state.
  const terminal: Terminal = {
    log: (message) => logged.push(message),
    async ask() {
      const authorization = new URL(logged.join("\n").match(/https:\/\/x\.com\/\S+/)?.[0] ?? "");
      const callback = new URL("https://app-one.example.com/callback");

      callback.searchParams.set("code", "auth-code");
      callback.searchParams.set("state", authorization.searchParams.get("state") ?? "");

      return callback.href;
    },
  };

  const fakeFetch: typeof fetch = async (input) => {
    const url = urlOf(input);

    if (url === "https://api.x.com/2/oauth2/token")
      return Response.json({
        access_token: "access-1",
        refresh_token: "refresh-1",
        expires_in: 7200,
        token_type: "bearer",
      });

    if (url === "https://api.x.com/2/users/me")
      return Response.json({ data: { id: "42", name: "App One", username: "appone" } });

    return new Response("unexpected", { status: 500 });
  };

  const credential = await connectOAuth(
    { id: "app-one-x", brandId: "app-one", label: "App One on X", platform: "x" },
    {
      X_CLIENT_ID: "client",
      X_CLIENT_SECRET: "secret",
      OAUTH_REDIRECT_URI: "https://app-one.example.com/callback",
    },
    terminal,
    undefined,
    fakeFetch,
  );

  assert.equal(credential.accountId, "42");
  assert.equal(credential.displayName, "App One");
  assert.equal(credential.token.accessToken, "access-1");
  assert.equal(credential.token.refreshToken, "refresh-1");
});

test("connecting Bluesky verifies the app password by logging in", async () => {
  const fakeFetch: typeof fetch = async (input, init) => {
    assert.equal(urlOf(input), "https://bsky.social/xrpc/com.atproto.server.createSession");
    assert.equal(init?.method, "POST");

    return Response.json({
      did: "did:plc:appone",
      handle: "app-one.bsky.social",
      accessJwt: "jwt",
    });
  };

  const credential = await connectBluesky(
    "app-one.bsky.social",
    "abcd-efgh-ijkl-mnop",
    "https://bsky.social",
    new Date("2026-09-26T12:00:00.000Z"),
    fakeFetch,
  );

  assert.equal(credential.did, "did:plc:appone");

  const rejecting: typeof fetch = async () =>
    Response.json(
      { error: "AuthenticationRequired", message: "Invalid identifier or password" },
      { status: 401 },
    );

  await assert.rejects(
    connectBluesky("app-one.bsky.social", "wrong", "https://bsky.social", new Date(), rejecting),
    /Invalid identifier or password/,
  );
});
