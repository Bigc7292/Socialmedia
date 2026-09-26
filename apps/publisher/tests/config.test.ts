import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { allAccounts, parsePublisherConfig, selectAccounts } from "../src/config.js";

const example = await readFile(new URL("../brands.example.json", import.meta.url), "utf8");

test("the example brands file parses with defaults filled in", () => {
  const config = parsePublisherConfig(example);

  assert.equal(config.brands.length, 4);
  assert.equal(allAccounts(config).length, 14);

  const youtube = allAccounts(config).find((account) => account.platform === "youtube");

  assert.deepEqual(youtube?.platform === "youtube" && [youtube.visibility, youtube.madeForKids], [
    "public",
    false,
  ]);
});

test("account ids must be unique across brands and platforms must be known", () => {
  const duplicate = JSON.stringify({
    brands: [
      { id: "one", accounts: [{ id: "shared", platform: "x" }] },
      { id: "two", accounts: [{ id: "shared", platform: "bluesky" }] },
    ],
  });

  assert.throws(() => parsePublisherConfig(duplicate), /used twice/);
  assert.throws(
    () =>
      parsePublisherConfig(
        JSON.stringify({ brands: [{ id: "one", accounts: [{ id: "a", platform: "myspace" }] }] }),
      ),
    /not one of/,
  );
  assert.throws(
    () => parsePublisherConfig(JSON.stringify({ brands: [{ id: "One App", accounts: [] }] })),
    /lowercase/,
  );
});

test("accounts are selected by brand, all brands, platform or account id", () => {
  const config = parsePublisherConfig(example);

  const ids = (brands: string[], only: string[]) =>
    selectAccounts(config, brands, only).map((account) => account.id);

  assert.equal(ids(["all"], []).length, 14);
  assert.deepEqual(ids(["app-two"], []), ["app-two-x", "app-two-bluesky", "app-two-linkedin"]);
  assert.deepEqual(ids(["all"], ["x"]), ["app-one-x", "app-two-x", "app-three-x", "app-four-x"]);
  assert.deepEqual(ids(["app-one", "app-four"], ["instagram"]), [
    "app-one-instagram",
    "app-four-instagram",
  ]);
  assert.deepEqual(ids(["all"], ["app-three-threads"]), ["app-three-threads"]);
  assert.throws(() => ids(["missing"], []), /No brand "missing"/);
});
