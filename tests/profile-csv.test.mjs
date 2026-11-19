import assert from "node:assert/strict";
import test from "node:test";
import { parseCsv, validateProfileCsv } from "../dist/services/profile-csv.js";

const PROFILE_HEADER =
  "profile_id,display_name,first_name,middle_name,last_name,name_prefix,name_suffix,preferred_first_name";
const NAME_HEADER =
  "profile_name_id,profile_id,name_type,first_name,middle_name,last_name,name_prefix,name_suffix,published_name,applies_from,applies_until,verification_status,public_display";

const run = (profileRows, nameRows, known) =>
  validateProfileCsv({
    profileCsv: [PROFILE_HEADER, ...profileRows].join("\n"),
    profileNameCsv: [NAME_HEADER, ...nameRows].join("\n"),
    knownProfileIds: known,
  });
const codes = (result) => result.issues.map((i) => i.code);

test("a clean pair of files maps to Website rows and publishes nothing by default", () => {
  const result = run(
    ["p1,Synthetic One,Synthetic,Q.,One,Dr.,Jr.,Syn", "p2,Synthetic Two,,,,,,"],
    [
      "n1,p1,nickname,,,,,,Synthetic Nick,,,,",
      "n2,p1,married_surname,,,,,,Synthetic Formerly,2010-01-01,2015-12-31,Confirmed,Yes",
      "n3,p2,other,,,,,,Synthetic Other,,,Requires review,No",
    ],
  );
  assert.equal(result.ok, true, JSON.stringify(result.issues));
  assert.equal(result.profiles.length, 2);
  assert.equal(result.profiles[0].lastName, "One");
  assert.equal(result.profiles[1].firstName, null);
  const [nick, formerly, other] = result.names;
  assert.equal(nick.fields.publicDisplay, false);
  assert.equal(nick.fields.verificationStatus, "requires_review");
  assert.equal(formerly.fields.publicDisplay, true);
  assert.equal(other.profileId, "p2");
});

test("a name can point at an existing Website Profile", () => {
  const result = run(
    [],
    ["n1,existing-1,nickname,,,,,,Synthetic Nick,,,,"],
    new Set(["existing-1"]),
  );
  assert.equal(result.ok, true);
});

test("an unknown Profile reference is an error and is never merged by name", () => {
  const result = run(
    ["p1,Synthetic One,,,,,,"],
    ["n1,p-unknown,nickname,,,,,,Synthetic One,,,,"],
  );
  assert.equal(result.ok, false);
  assert.deepEqual(codes(result), ["unknown_profile"]);
  assert.deepEqual(result.names, []);
});

test("two Profiles with the same name stay separate rows", () => {
  const result = run(
    ["p1,Synthetic Same Name,,,,,,", "p2,Synthetic Same Name,,,,,,"],
    [],
  );
  assert.equal(result.ok, true);
  assert.deepEqual(
    result.profiles.map((p) => p.profileId),
    ["p1", "p2"],
  );
});

test("duplicate and missing IDs are reported with the row number", () => {
  const result = run(
    [
      "p1,Synthetic One,,,,,,",
      "p1,Synthetic Dup,,,,,,",
      ",Synthetic Blank,,,,,,",
    ],
    [
      "n1,p1,nickname,,,,,,Synthetic A,,,,",
      "n1,p1,nickname,,,,,,Synthetic B,,,,",
      ",p1,nickname,,,,,,Synthetic C,,,,,",
    ],
  );
  const dup = result.issues.filter((i) => i.code === "duplicate_id");
  assert.deepEqual(
    dup.map((i) => [i.file, i.row]),
    [
      ["profile.csv", 3],
      ["profile_name.csv", 3],
    ],
  );
  assert.ok(codes(result).includes("missing_value"));
});

test("unsupported types, bad dates, bad flags and unapproved public names are errors", () => {
  const result = run(
    ["p1,Synthetic One,,,,,,"],
    [
      "n1,p1,alias,,,,,,Synthetic A,,,,",
      "n2,p1,nickname,,,,,,Synthetic B,2020-02-31,,,",
      "n3,p1,nickname,,,,,,Synthetic C,2020-05-01,2019-05-01,,",
      "n4,p1,nickname,,,,,,Synthetic D,,,,Maybe",
      "n5,p1,nickname,,,,,,Synthetic E,,,Requires review,Yes",
      "n6,p1,nickname,,,,,,Synthetic F,,,Probably,No",
    ],
  );
  assert.deepEqual(
    codes(result),
    [
      "invalid_value",
      "invalid_date",
      "date_order",
      "invalid_value",
      "public_not_allowed",
      "invalid_value",
    ],
    JSON.stringify(result.issues),
  );
  assert.deepEqual(result.names, []);
});

test("the same name, type and dates twice for one Profile is a duplicate", () => {
  const result = run(
    ["p1,Synthetic One,,,,,,"],
    [
      "n1,p1,nickname,,,,,,Synthetic Nick,,,,",
      "n2,p1,nickname,,,,,,  synthetic   nick ,,,,",
    ],
  );
  assert.deepEqual(codes(result), ["duplicate_name"]);
});

test("missing and unknown columns are reported", () => {
  const result = validateProfileCsv({
    profileCsv: "profile_id,mystery\np1,x",
    profileNameCsv: "profile_name_id\nn1",
  });
  const found = result.issues.map((i) => `${i.file}:${i.code}:${i.column}`);
  assert.ok(found.includes("profile.csv:missing_column:display_name"));
  assert.ok(found.includes("profile.csv:unknown_column:mystery"));
  assert.ok(found.includes("profile_name.csv:missing_column:name_type"));
});

test("over-long values are refused", () => {
  const result = run([`p1,Synthetic One,,,,,${"x".repeat(51)},`], []);
  assert.deepEqual(codes(result), ["too_long"]);
});

test("quoted commas, quotes and line breaks parse, and an open quote is refused", () => {
  assert.deepEqual(parseCsv('a,"b,c","d ""e"""\n1,2,3\n'), [
    ["a", "b,c", 'd "e"'],
    ["1", "2", "3"],
  ]);
  assert.deepEqual(parseCsv("a,b\r\n1,2\r\n"), [
    ["a", "b"],
    ["1", "2"],
  ]);
  assert.equal(parseCsv('a,"open'), null);
  const result = validateProfileCsv({
    profileCsv: 'profile_id,display_name\np1,"Synthetic, Comma"',
    profileNameCsv: NAME_HEADER,
  });
  assert.equal(result.ok, true);
  assert.equal(result.profiles[0].displayName, "Synthetic, Comma");
});

test("a valid result is all or nothing: one error returns no rows", () => {
  const result = run(
    ["p1,Synthetic One,,,,,,"],
    [
      "n1,p1,nickname,,,,,,Synthetic Good,,,,",
      "n2,p1,bogus,,,,,,Synthetic Bad,,,,",
    ],
  );
  assert.equal(result.ok, false);
  assert.deepEqual(result.profiles, []);
  assert.deepEqual(result.names, []);
});
