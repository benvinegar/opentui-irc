/* oxlint-disable no-control-regex -- Reject terminal controls in externally supplied form values. */
import type { NetworkId, SecretRef } from "../contracts/common";
import type { NetworkProfile } from "../contracts/settings";

/** Add-network form fields. The password itself never leaves the form; only whether one is entered. */
export interface NetworkFormValues {
  readonly name: string;
  readonly host: string;
  readonly port: string;
  readonly nick: string;
  readonly account: string;
  readonly authMode: "vault" | "environment";
  readonly variable: string;
  readonly hasPassword: boolean;
  readonly hasStoredSecret: boolean;
  readonly channel: string;
}

const invalidEndpoint = (form: NetworkFormValues) =>
  !form.host.trim() ||
  /[\s\u0000-\u001f]/u.test(form.host) ||
  !/^[1-9]\d{0,4}$/u.test(form.port) ||
  +form.port > 65535 ||
  !form.nick.trim() ||
  /[\s,:\u0000-\u001f]/u.test(form.nick);

const incompleteCredentials = (form: NetworkFormValues) =>
  form.account
    ? form.authMode === "vault" && !form.hasPassword && !form.hasStoredSecret
    : form.hasPassword || !!form.variable || form.hasStoredSecret;

/** First problem with the form, phrased for a newcomer, or undefined when it can be saved. */
export function networkFormError(form: NetworkFormValues): string | undefined {
  if (invalidEndpoint(form))
    return "Enter a hostname, a port from 1–65535, and a nickname without spaces.";
  if (incompleteCredentials(form))
    return "Enter both your SASL account and password, or leave both empty for a network without account authentication.";
  if (
    form.account &&
    form.authMode === "environment" &&
    !/^[A-Za-z_][A-Za-z0-9_]{0,255}$/u.test(form.variable)
  )
    return "Enter the NAME of an environment variable containing your password, not the password itself.";
  if (form.channel && !/^[#&+!][^\s,\u0000-\u001f]+$/u.test(form.channel))
    return "The optional channel should look like #welcome.";
  return undefined;
}

/** New TLS profile from a validated form; it never connects automatically. */
export function networkProfile(
  id: NetworkId,
  form: NetworkFormValues,
  passwordRef: SecretRef | undefined,
): NetworkProfile {
  const nick = form.nick.trim();
  return {
    id,
    name: form.name.trim() || form.host.trim(),
    endpoints: [{ host: form.host.trim(), port: +form.port, tls: true }],
    identity: {
      nick,
      alternateNicks: [`${nick}_`],
      username: nick,
      realname: "opentui-irc user",
    },
    autoConnect: false,
    autoJoin: form.channel ? [{ channel: form.channel }] : [],
    ...(form.account && passwordRef
      ? {
          sasl: {
            mechanism: "PLAIN",
            account: form.account,
            password: passwordRef,
            required: true,
          },
        }
      : {}),
  };
}
