/* oxlint-disable no-control-regex -- Reject terminal controls in externally supplied form values. */
import { For, Show, createSignal, onCleanup } from "solid-js";
import type { AppApi } from "../contracts/app";
import { entityId, type SecretRef } from "../contracts/common";
import type { SettingsDocument } from "../contracts/settings";
import { Button, Field, usePalette } from "./primitives";
import { SecureField } from "./secure-field";

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
  const [password, setPassword] = createSignal("");
  const [authMode, setAuthMode] = createSignal<"vault" | "environment">("vault");
  const [storedSecret, setStoredSecret] = createSignal<SecretRef>();
  const formAbort = new AbortController();
  const abortForm = () => formAbort.abort();
  if (props.signal.aborted) formAbort.abort();
  else props.signal.addEventListener("abort", abortForm, { once: true });
  onCleanup(() => {
    formAbort.abort();
    setPassword("");
    props.signal.removeEventListener("abort", abortForm);
  });
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
      (account() && authMode() === "vault" && !password() && !storedSecret()) ||
      (!account() && (password() || variable() || storedSecret()))
    ) {
      setError(
        "Enter both your SASL account and password, or leave both empty for a network without account authentication.",
      );
      return;
    }
    if (
      account() &&
      authMode() === "environment" &&
      !/^[A-Za-z_][A-Za-z0-9_]{0,255}$/u.test(variable())
    ) {
      setError(
        "Enter the NAME of an environment variable containing your password, not the password itself.",
      );
      return;
    }
    if (channel() && !/^[#&+!][^\s,\u0000-\u001f]+$/u.test(channel())) {
      setError("The optional channel should look like #welcome.");
      return;
    }
    setBusy(true);
    setError("");
    let passwordRef = storedSecret();
    if (account() && authMode() === "vault" && !passwordRef) {
      const secretValue = password();
      setPassword("");
      const secured = await props.app.storeSecret(secretValue, formAbort.signal);
      if (!secured.ok) {
        setBusy(false);
        setError(
          `${secured.error.message} Use the environment-reference fallback below if your OS vault is unavailable. Password input was cleared.`,
        );
        return;
      }
      passwordRef = secured.value;
      setStoredSecret(passwordRef);
    } else if (account() && authMode() === "environment")
      passwordRef = entityId<"secret-ref">(`env:${variable()}`);
    if (formAbort.signal.aborted) {
      setBusy(false);
      return;
    }
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
              ...(account() && passwordRef
                ? {
                    sasl: {
                      mechanism: "PLAIN",
                      account: account(),
                      password: passwordRef,
                      required: true,
                    },
                  }
                : {}),
            },
          ],
        },
      },
      original.revision,
      formAbort.signal,
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
  const preset = (label: string, hostname: string) => {
    setName(label);
    setHost(hostname);
    setPort("6697");
    setError("");
    setPassword("");
    setStoredSecret(undefined);
    setAccount("");
    setVariable("");
    setChannel("");
  };
  const saveTyping = async () => {
    if (busy()) return;
    setBusy(true);
    const result = await props.app.saveSettings(
      { section: "user", value: { ...original.user, sendTyping: !original.user.sendTyping } },
      original.revision,
      formAbort.signal,
    );
    setBusy(false);
    if (result.ok) {
      props.status(
        "Typing preference saved. Activity is shared only with networks that negotiate support.",
      );
      props.focus("settings");
    } else setError(result.error.message);
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
        Secure TLS connections only. Account passwords are hidden and saved in your OS credential
        vault, never in settings. Local history is{" "}
        {original.user.history.enabled ? "enabled" : "disabled"}
        {original.user.history.enabled
          ? ` with ${original.user.history.retentionDays ?? "unlimited"}-day retention`
          : ""}
        ; review Privacy below.
      </text>
      <text fg={colors.muted}>
        Optional presets only fill the form; nothing connects until you save and choose Connect.
      </text>
      <box height={1} flexShrink={0} flexDirection="row">
        <Button
          id="preset-libera"
          layer="modal"
          label="Libera.Chat"
          disabled={busy()}
          onPress={() => preset("Libera.Chat", "irc.libera.chat")}
        />
        <Button
          id="preset-oftc"
          layer="modal"
          label="OFTC"
          disabled={busy()}
          onPress={() => preset("OFTC", "irc.oftc.net")}
        />
      </box>
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
      <Show
        when={authMode() === "vault"}
        fallback={
          <Field
            id="network-env"
            label="Password environment variable NAME, not password"
            value={variable()}
            onInput={setVariable}
            placeholder="OPENIRC_PASSWORD"
          />
        }
      >
        <SecureField
          id="network-password"
          value={password()}
          onInput={(value) => {
            setPassword(value);
            setStoredSecret(undefined);
          }}
          onError={setError}
        />
        <Show when={storedSecret()}>
          <text fg={colors.green}>Password stored securely. Only its reference will be saved.</text>
        </Show>
      </Show>
      <Button
        id="auth-mode"
        layer="modal"
        label={
          authMode() === "vault"
            ? "Use environment reference instead (fallback)"
            : "Use a hidden password with OS vault instead"
        }
        onPress={() => {
          setPassword("");
          setStoredSecret(undefined);
          setVariable("");
          setAuthMode(authMode() === "vault" ? "environment" : "vault");
        }}
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
      <text fg={colors.muted}>
        Share typing activity: {original.user.sendTyping ? "on" : "off"}. This is optional,
        transient, and only works on supported networks.
      </text>
      <Button
        id="typing-toggle"
        layer="modal"
        label={
          original.user.sendTyping
            ? "Stop sharing typing activity"
            : "Share typing activity on supported networks"
        }
        disabled={busy()}
        onPress={() => void saveTyping()}
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
