import assert from "node:assert/strict";
import { mkdtemp, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { CredentialFile, type OAuthCredential } from "../src/credentials.js";
import { freshCredential, needsRefresh } from "../src/tokens.js";

const now = new Date("2026-09-26T12:00:00.000Z");

function xCredential(expiresAt: string, refreshToken?: string): OAuthCredential {
  const token =
    refreshToken === undefined
      ? { accessToken: "old-access", expiresAt }
      : { accessToken: "old-access", expiresAt, refreshToken };

  return {
    kind: "oauth",
    platform: "x",
    accountId: "123",
    displayName: "App One",
    token,
    updatedAt: now.toISOString(),
  };
}

test("credentials survive a round trip and are readable only by the owner", async () => {
  const path = join(await mkdtemp(join(tmpdir(), "publisher-")), "nested", "credentials.json");
  const file = await CredentialFile.open(path);

  await file.set("app-one-x", xCredential("2026-09-26T14:00:00.000Z", "refresh-1"));
  await file.set("app-one-bluesky", {
    kind: "bluesky-app-password",
    platform: "bluesky",
    service: "https://bsky.social",
    identifier: "app-one.bsky.social",
    appPassword: "abcd-efgh-ijkl-mnop",
    did: "did:plc:appone",
    displayName: "app-one.bsky.social",
    updatedAt: now.toISOString(),
  });

  const reopened = await CredentialFile.open(path);

  assert.deepEqual(reopened.get("app-one-x"), xCredential("2026-09-26T14:00:00.000Z", "refresh-1"));
  assert.equal(reopened.get("app-one-bluesky")?.kind, "bluesky-app-password");
  assert.equal((await stat(path)).mode & 0o777, 0o600);
});

test("short-lived tokens refresh five minutes early; Meta tokens a week early", () => {
  assert.equal(needsRefresh(xCredential("2026-09-26T12:04:00.000Z"), now), true);
  assert.equal(needsRefresh(xCredential("2026-09-26T12:10:00.000Z"), now), false);

  const threads: OAuthCredential = {
    ...xCredential("2026-10-01T12:00:00.000Z"),
    platform: "threads",
  };

  assert.equal(needsRefresh(threads, now), true);
});

test("an expiring X token is refreshed and keeps its refresh token when X does not rotate it", async () => {
  const requests: string[] = [];

  const fakeFetch: typeof fetch = async (input, init) => {
    requests.push(
      `${init?.method ?? "GET"} ${input instanceof Request ? input.url : String(input)}`,
    );

    return Response.json({ access_token: "new-access", token_type: "bearer", expires_in: 7200 });
  };

  const refreshed = await freshCredential(
    xCredential("2026-09-26T12:01:00.000Z", "refresh-1"),
    { X_CLIENT_ID: "client", X_CLIENT_SECRET: "secret" },
    now,
    fakeFetch,
  );

  assert.deepEqual(requests, ["POST https://api.x.com/2/oauth2/token"]);
  assert.equal(refreshed.token.accessToken, "new-access");
  assert.equal(refreshed.token.refreshToken, "refresh-1");
});

test("an expired token without a refresh token asks for a reconnect", async () => {
  const linkedin: OAuthCredential = {
    ...xCredential("2026-09-25T12:00:00.000Z"),
    platform: "linkedin",
    accountId: "urn:li:person:abc",
  };

  await assert.rejects(freshCredential(linkedin, {}, now), /Run connect again/);
});
