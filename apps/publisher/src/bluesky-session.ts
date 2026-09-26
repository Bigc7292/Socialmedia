import { isRecord, isString, parseJson, requiredString } from "./guards.js";

export interface BlueskySession {
  readonly did: string;
  readonly handle: string;
  readonly accessJwt: string;
}

/**
 * Log in with a Bluesky app password (Settings → Privacy and security → App
 * passwords). Access tokens last a couple of hours, so log in on every run.
 */
export async function createBlueskySession(
  service: string,
  identifier: string,
  appPassword: string,
  fetcher: typeof fetch = fetch,
): Promise<BlueskySession> {
  const url = new URL("/xrpc/com.atproto.server.createSession", service);

  if (url.protocol !== "https:") throw new Error("The Bluesky service must use https");

  const response = await fetcher(url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ identifier, password: appPassword }),
  });

  const body = parseJson(await response.text());

  if (!response.ok) {
    const message = isRecord(body) ? body["message"] : undefined;

    throw new Error(
      `Bluesky login for ${identifier} failed (${response.status})${isString(message) ? `: ${message}` : ""}`,
    );
  }

  if (!isRecord(body)) throw new Error("Bluesky returned an unexpected login response");

  return {
    did: requiredString(body, "did", "Bluesky login"),
    handle: requiredString(body, "handle", "Bluesky login"),
    accessJwt: requiredString(body, "accessJwt", "Bluesky login"),
  };
}
