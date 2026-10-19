/* oxlint-disable no-control-regex -- Reject terminal controls in externally supplied form values. */
import { For, Show, createSignal } from "solid-js";
import type { AppApi } from "../contracts/app";
import { entityId } from "../contracts/common";
import type { SettingsDocument } from "../contracts/settings";
import { Button, Field, usePalette } from "./primitives";

export function SettingsForm(props: {
  app: AppApi;
  document: SettingsDocument;
  signal: AbortSignal;
  focus: (id: string) => void;
  status: (text: string) => void;
}) {
  const colors = usePalette();
  const [name, setName] = createSignal("");
  const [host, setHost] = createSignal("");
  const [port, setPort] = createSignal("6697");
  const [nick, setNick] = createSignal("");
  const [account, setAccount] = createSignal("");
  const [variable, setVariable] = createSignal("");
  const [channel, setChannel] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal("");
  const [theme, setTheme] = createSignal(props.document.tui.theme);
  // Capture revision at form creation, never silently overwrite externally changed settings.
  const original = props.document;
  const add = async () => {
    if (busy()) return;
    if (
      !host().trim() ||
      /[\s\u0000-\u001f]/u.test(host()) ||
      !/^[1-9]\d{0,4}$/u.test(port()) ||
      +port() > 65535 ||
      !nick().trim() ||
      /[\s,:\u0000-\u001f]/u.test(nick())
    ) {
      setError("Enter a hostname, a port from 1–65535, and a nickname without spaces.");
      return;
    }
    if (
      !!account() !== !!variable() ||
      (variable() && !/^[A-Za-z_][A-Za-z0-9_]{0,255}$/u.test(variable()))
    ) {
      setError(
        "For SASL, enter both the account and the name of an environment variable containing its password.",
      );
      return;
    }
    if (channel() && !/^[#&+!][^\s,\u0000-\u001f]+$/u.test(channel())) {
      setError("The optional channel should look like #welcome.");
      return;
    }
    setBusy(true);
    setError("");
    const id = entityId<"network">(`network-${crypto.randomUUID()}`);
    const result = await props.app.saveSettings(
      {
        section: "user",
        value: {
          ...original.user,
          networks: [
            ...original.user.networks,
            {
              id,
              name: name().trim() || host().trim(),
              endpoints: [{ host: host().trim(), port: +port(), tls: true }],
              identity: {
                nick: nick().trim(),
                alternateNicks: [`${nick().trim()}_`],
                username: nick().trim(),
                realname: "OpenIRC user",
              },
              autoConnect: false,
              autoJoin: channel() ? [{ channel: channel() }] : [],
              ...(account()
                ? {
                    sasl: {
                      mechanism: "PLAIN",
                      account: account(),
                      password: entityId<"secret-ref">(`env:${variable()}`),
                      required: true,
                    },
                  }
                : {}),
            },
          ],
        },
      },
      original.revision,
      props.signal,
    );
    setBusy(false);
    if (!result.ok) {
      setError(
        result.error.message +
          (result.error.code === "conflict" ? " Close and reopen Settings to reload changes." : ""),
      );
      return;
    }
    props.status(
      "Network saved. Choose Connect beside its name. Credentials are never written to settings.",
    );
    props.focus(`connect-${id}`);
  };
  const savePrivacy = async () => {
    if (busy()) return;
    setBusy(true);
    const result = await props.app.saveSettings(
      {
        section: "user",
        value: {
          ...original.user,
          history: { ...original.user.history, enabled: !original.user.history.enabled },
        },
      },
      original.revision,
      props.signal,
    );
    setBusy(false);
    props.status(
      result.ok
        ? "History preference saved. Existing local history is retained; this does not delete it."
        : result.error.message,
    );
  };
  return (
    <>
      <text fg={colors.muted}>
        Secure TLS connections only in this setup form. Set your password in an environment variable
        before starting OpenIRC; enter only its name below.
      </text>
      <Field
        id="network-name"
        label="Network display name"
        value={name()}
        onInput={setName}
        placeholder="My community"
      />
      <Field
        id="network-host"
        label="Server hostname"
        value={host()}
        onInput={setHost}
        placeholder="irc.example.org"
      />
      <Field id="network-port" label="TLS port" value={port()} onInput={setPort} />
      <Field
        id="network-nick"
        label="Your nickname"
        value={nick()}
        onInput={setNick}
        placeholder="newcomer"
      />
      <Field
        id="network-account"
        label="SASL account (optional)"
        value={account()}
        onInput={setAccount}
      />
      <Field
        id="network-env"
        label="Password environment variable NAME, not password"
        value={variable()}
        onInput={setVariable}
        placeholder="OPENIRC_PASSWORD"
      />
      <Field
        id="network-channel"
        label="Channel to join after connecting (optional)"
        value={channel()}
        onInput={setChannel}
        placeholder="#welcome"
      />
      <Show when={error()}>
        <text fg={colors.error}>{error()}</text>
      </Show>
      <Button
        id="network-save"
        layer="modal"
        label={busy() ? "Saving…" : "Save network"}
        disabled={busy()}
        onPress={() => void add()}
      />
      <text fg={colors.accent}>Privacy</text>
      <text fg={colors.muted}>
        Local history: {original.user.history.enabled ? "on" : "off"}. Retention:{" "}
        {original.user.history.retentionDays ?? "unlimited"} days. Draft persistence:{" "}
        {original.user.history.persistDrafts ? "on" : "off"}. Existing history is retained when
        disabled.
      </text>
      <Button
        id="history-toggle"
        layer="modal"
        label={
          original.user.history.enabled
            ? "Disable future history logging"
            : "Enable history logging"
        }
        disabled={busy()}
        onPress={() => void savePrivacy()}
      />
      <text fg={colors.accent}>Appearance</text>
      <box flexDirection="row" height={1}>
        <For each={["dark", "light", "high-contrast"] as const}>
          {(value) => (
            <Button
              id={`theme-${value}`}
              layer="modal"
              label={value}
              active={theme() === value}
              onPress={() => setTheme(value)}
            />
          )}
        </For>
      </box>
      <Button
        id="appearance-save"
        layer="modal"
        label="Save appearance"
        disabled={busy()}
        onPress={() => {
          void (async () => {
            setBusy(true);
            const result = await props.app.saveSettings(
              { section: "tui", value: { ...original.tui, theme: theme() } },
              original.revision,
              props.signal,
            );
            setBusy(false);
            props.status(result.ok ? "Appearance saved." : result.error.message);
          })();
        }}
      />
    </>
  );
}
