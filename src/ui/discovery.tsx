import { createEffect, createMemo, createSignal, For, onCleanup, Show } from "solid-js";
import type { AppAction, AppApi } from "../contracts/app";
import type { NetworkId } from "../contracts/common";
import type { DiscoverySnapshot } from "../contracts/discovery";
import { Button, Field, usePalette } from "./primitives";

export function DiscoveryPanel(props: {
  app: AppApi;
  networkId: NetworkId;
  networkName: string;
  mode: "directory" | "whois";
  requestedNick: string;
  dispatch: (action: AppAction) => Promise<boolean>;
  close: () => void;
}) {
  const colors = usePalette();
  const [snapshot, setSnapshot] = createSignal<DiscoverySnapshot>();
  const [filter, setFilter] = createSignal("");
  const [nick, setNick] = createSignal(props.requestedNick);
  const [error, setError] = createSignal("");
  createEffect(() => setNick(props.requestedNick));
  createEffect(() => {
    const model = props.app.discovery(props.networkId);
    setSnapshot(undefined);
    if (!model.ok) {
      setError(model.error.message);
      return;
    }
    setError("");
    setSnapshot(model.value.getSnapshot());
    onCleanup(model.value.subscribe(() => setSnapshot(model.value.getSnapshot())));
  });
  const matches = createMemo(() => {
    const query = filter().toLowerCase();
    return (
      snapshot()?.directory.items.filter((item) =>
        `${item.channel} ${item.topic}`.toLowerCase().includes(query),
      ) ?? []
    );
  });
  const requestUser = () => {
    const value = nick().trim();
    if (!value || /[\s,:]/u.test(value)) {
      setError("Enter one nickname without spaces.");
      return;
    }
    setError("");
    void props.dispatch({
      type: "irc.request",
      networkId: props.networkId,
      command: { type: "whois", nick: value },
    });
  };
  const join = async (channel: string) => {
    if (await props.dispatch({ type: "conversation.join", networkId: props.networkId, channel }))
      props.close();
  };
  return (
    <>
      <text fg={colors.muted}>
        Network: {props.networkName}. Results belong to this network, even if you switch
        conversations.
      </text>
      <Show when={error()}>
        <text fg={colors.error}>{error()}</text>
      </Show>
      <Show
        when={props.mode === "directory"}
        fallback={
          <>
            <Field
              id="whois-nick"
              label="Look up a nickname"
              value={nick()}
              onInput={setNick}
              onSubmit={requestUser}
            />
            <Button
              id="whois-request"
              layer="modal"
              label={snapshot()?.user.state === "loading" ? "Looking up…" : "Look up person"}
              disabled={snapshot()?.user.state === "loading"}
              onPress={requestUser}
            />
            <Show when={snapshot()?.user.state === "loading"}>
              <text fg={colors.muted}>Waiting for the network’s WHOIS response…</text>
            </Show>
            <Show when={snapshot()?.user.state === "idle"}>
              <text fg={colors.muted}>
                Enter a nickname and choose Look up person. The network may omit private details.
              </text>
            </Show>
            <Show when={snapshot()?.user.error}>
              <text fg={colors.error}>{snapshot()?.user.error?.message}</text>
            </Show>
            <Show when={snapshot()?.user.state === "ready" && snapshot()?.user.details}>
              {() => {
                const details = () => snapshot()?.user.details;
                return (
                  <>
                    <text fg={colors.accent}>
                      <b>{details()?.nick}</b>
                    </text>
                    <text fg={colors.text}>Name: {details()?.realname ?? "not provided"}</text>
                    <text fg={colors.text}>Account: {details()?.account ?? "not provided"}</text>
                    <text fg={colors.muted}>
                      Username: {details()?.username ?? "not provided"} · Host:{" "}
                      {details()?.hostname ?? "not provided"}
                    </text>
                    <text fg={colors.text}>
                      {details()?.awayReason
                        ? `Away: ${details()?.awayReason}`
                        : "No away message reported."}
                    </text>
                    <Button
                      id="whois-message"
                      layer="modal"
                      label="Start a direct conversation"
                      onPress={() => {
                        const value = details()?.nick;
                        if (value)
                          void props
                            .dispatch({
                              type: "conversation.query",
                              networkId: props.networkId,
                              nick: value,
                            })
                            .then((ok) => {
                              if (ok) props.close();
                            });
                      }}
                    />
                    <text fg={colors.muted}>
                      Visible channels: {details()?.channels.join(", ") || "none reported"}
                    </text>
                  </>
                );
              }}
            </Show>
          </>
        }
      >
        <Field
          id="directory-filter"
          label="Filter channel names and topics locally"
          value={filter()}
          onInput={setFilter}
          placeholder="Search this directory"
        />
        <Button
          id="directory-refresh"
          layer="modal"
          label={
            snapshot()?.directory.state === "loading"
              ? "Receiving directory…"
              : "Request channel directory"
          }
          disabled={snapshot()?.directory.state === "loading"}
          onPress={() => {
            void props.dispatch({
              type: "irc.request",
              networkId: props.networkId,
              command: { type: "list" },
            });
          }}
        />
        <Show when={snapshot()?.directory.state === "idle"}>
          <text fg={colors.muted}>
            Choose Request channel directory to ask the network for public channels.
          </text>
        </Show>
        <Show when={snapshot()?.directory.error}>
          <text fg={colors.error}>{snapshot()?.directory.error?.message}</text>
        </Show>
        <Show when={snapshot()?.directory.truncated}>
          <text fg={colors.error}>
            The network directory exceeded the application limit. Some channels are omitted; you can
            still join a channel by name.
          </text>
        </Show>
        <text fg={colors.muted}>
          {matches().length} matches · displaying up to 100. Refine the filter to find more.{" "}
          {snapshot()?.directory.state === "loading" ? "Results are still arriving." : ""}
        </text>
        <For each={matches().slice(0, 100)}>
          {(item, index) => (
            <box flexDirection="column" flexShrink={0}>
              <Button
                id={`directory-join-${index()}`}
                layer="modal"
                label={`Join ${item.channel} · ${item.userCount} people`}
                onPress={() => void join(item.channel)}
              />
              <text fg={colors.muted}>{item.topic || "No topic provided"}</text>
            </box>
          )}
        </For>
        <Show when={snapshot()?.directory.state === "ready" && !matches().length}>
          <text fg={colors.muted}>
            No channels match. Try a shorter filter or join a known channel by name.
          </text>
        </Show>
      </Show>
    </>
  );
}
