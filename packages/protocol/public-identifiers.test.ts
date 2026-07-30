import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  isReservedPublicIdentifier,
  parseSpaceSlug,
  parseUsername,
  validatePublicIdentifierAssignment,
} from "./src/public-identifiers.js";

describe("public identifier parsing", () => {
  it("keeps reserved historical usernames readable", () => {
    assert.equal(parseUsername(" Changelog "), "changelog");
    assert.equal(parseUsername("alice"), "alice");
    assert.equal(parseUsername("bad--name"), null);
  });

  it("parses canonical space slugs without changing case", () => {
    assert.equal(parseSpaceSlug("home_space"), "home_space");
    assert.equal(parseSpaceSlug("Home"), null);
  });
});

describe("public identifier assignment", () => {
  it("blocks platform paths for usernames and space slugs", () => {
    assert.deepEqual(validatePublicIdentifierAssignment("username", "docs"), {
      value: null,
      reason: "reserved",
    });
    assert.deepEqual(validatePublicIdentifierAssignment("spaceSlug", "settings"), {
      value: null,
      reason: "reserved",
    });
  });

  it("reserves the Work route discriminator only for space slugs", () => {
    assert.equal(isReservedPublicIdentifier("spaceSlug", "w"), true);
    assert.equal(isReservedPublicIdentifier("username", "w"), false);
  });

  it("accepts ordinary public identifiers", () => {
    assert.deepEqual(validatePublicIdentifierAssignment("username", "alice-2"), {
      value: "alice-2",
      reason: null,
    });
    assert.deepEqual(validatePublicIdentifierAssignment("spaceSlug", "home"), {
      value: "home",
      reason: null,
    });
  });
});
