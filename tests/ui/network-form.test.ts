import { describe, expect, it } from "vitest";
import { entityId } from "../../src/contracts/common";
import {
  networkFormError,
  networkProfile,
  type NetworkFormValues,
} from "../../src/ui/network-form";

const ENDPOINT = "Enter a hostname, a port from 1–65535, and a nickname without spaces.";
const CREDENTIALS =
  "Enter both your SASL account and password, or leave both empty for a network without account authentication.";
const VARIABLE =
  "Enter the NAME of an environment variable containing your password, not the password itself.";
const CHANNEL = "The optional channel should look like #welcome.";

const form = (overrides: Partial<NetworkFormValues> = {}): NetworkFormValues => ({
  name: "",
  host: "irc.example.test",
  port: "6697",
  nick: "newcomer",
  account: "",
  authMode: "vault",
  variable: "",
  hasPassword: false,
  hasStoredSecret: false,
  channel: "",
  ...overrides,
});

describe("add-network form validation", () => {
  it("accepts a minimal TLS network without credentials", () => {
    expect(networkFormError(form())).toBeUndefined();
  });

  it.each([
    ["an empty host", { host: "  " }],
    ["a host with spaces", { host: "irc example.test" }],
    ["a host with control characters", { host: "irc.example.test\u0007" }],
    ["a non-numeric port", { port: "66a" }],
    ["port zero", { port: "0" }],
    ["a leading-zero port", { port: "06697" }],
    ["a port above 65535", { port: "65536" }],
    ["a six-digit port", { port: "123456" }],
    ["an empty nick", { nick: " " }],
    ["a nick with spaces", { nick: "new comer" }],
    ["a nick with a comma", { nick: "a,b" }],
    ["a nick with a colon", { nick: "a:b" }],
    ["a nick with control characters", { nick: "nick\u001b" }],
  ])("rejects %s", (_label, overrides) => {
    expect(networkFormError(form(overrides))).toBe(ENDPOINT);
  });

  it("accepts the edge ports", () => {
    expect(networkFormError(form({ port: "1" }))).toBeUndefined();
    expect(networkFormError(form({ port: "65535" }))).toBeUndefined();
  });

  it("requires a password, or a stored one, for a vault account", () => {
    expect(networkFormError(form({ account: "me" }))).toBe(CREDENTIALS);
    expect(networkFormError(form({ account: "me", hasPassword: true }))).toBeUndefined();
    expect(networkFormError(form({ account: "me", hasStoredSecret: true }))).toBeUndefined();
  });

  it.each([
    ["a password", { hasPassword: true }],
    ["an environment variable", { variable: "OPENIRC_PASSWORD" }],
    ["a stored secret", { hasStoredSecret: true }],
  ])("rejects %s without an account", (_label, overrides) => {
    expect(networkFormError(form(overrides))).toBe(CREDENTIALS);
  });

  it("requires a valid environment variable name for environment references", () => {
    const environment = { account: "me", authMode: "environment" as const };
    expect(networkFormError(form(environment))).toBe(VARIABLE);
    expect(networkFormError(form({ ...environment, variable: "1PASSWORD" }))).toBe(VARIABLE);
    expect(networkFormError(form({ ...environment, variable: "hunter2 secret" }))).toBe(VARIABLE);
    expect(networkFormError(form({ ...environment, variable: "A".repeat(257) }))).toBe(VARIABLE);
    expect(networkFormError(form({ ...environment, variable: "_OPENIRC_PASS" }))).toBeUndefined();
  });

  it("checks the optional channel shape", () => {
    for (const channel of ["#welcome", "&local", "+modeless", "!safe"])
      expect(networkFormError(form({ channel }))).toBeUndefined();
    for (const channel of ["welcome", "#", "#two words", "#a,b", "#bell\u0007"])
      expect(networkFormError(form({ channel }))).toBe(CHANNEL);
  });

  it("reports endpoint problems before credential problems", () => {
    expect(networkFormError(form({ host: "", account: "me", channel: "bad" }))).toBe(ENDPOINT);
    expect(networkFormError(form({ account: "me", channel: "bad" }))).toBe(CREDENTIALS);
  });
});

describe("add-network profile", () => {
  const id = entityId<"network">("network-test");

  it("builds a manual-connect TLS profile from trimmed fields", () => {
    expect(
      networkProfile(
        id,
        form({ name: "  Example  ", host: " irc.example.test ", nick: " newcomer ", port: "7000" }),
        undefined,
      ),
    ).toEqual({
      id,
      name: "Example",
      endpoints: [{ host: "irc.example.test", port: 7000, tls: true }],
      identity: {
        nick: "newcomer",
        alternateNicks: ["newcomer_"],
        username: "newcomer",
        realname: "opentui-irc user",
      },
      autoConnect: false,
      autoJoin: [],
    });
  });

  it("falls back to the host as the display name and joins the optional channel", () => {
    const profile = networkProfile(id, form({ name: " ", channel: "#welcome" }), undefined);
    expect(profile.name).toBe("irc.example.test");
    expect(profile.autoJoin).toEqual([{ channel: "#welcome" }]);
  });

  it("adds required SASL PLAIN only with both an account and a password reference", () => {
    const password = entityId<"secret-ref">("env:OPENIRC_PASSWORD");
    expect(networkProfile(id, form({ account: "me", hasPassword: true }), password).sasl).toEqual({
      mechanism: "PLAIN",
      account: "me",
      password,
      required: true,
    });
    expect(networkProfile(id, form({ account: "me" }), undefined)).not.toHaveProperty("sasl");
    expect(networkProfile(id, form(), password)).not.toHaveProperty("sasl");
  });

  it("never carries password presence flags or the form into the profile", () => {
    const profile = networkProfile(
      id,
      form({ hasPassword: true, hasStoredSecret: true }),
      undefined,
    );
    expect(Object.keys(profile).sort()).toEqual(
      ["autoConnect", "autoJoin", "endpoints", "id", "identity", "name"].sort(),
    );
  });
});
