import { createEffect, createMemo, createSignal, For, onCleanup, Show } from "solid-js";
import type { AppAction, AppApi } from "../contracts/app";
import type { NetworkId } from "../contracts/common";
import type { ChannelListing, DiscoverySnapshot } from "../contracts/discovery";
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
  const startConversation = (value: string) => {
    void props
      .dispatch({ type: "conversation.query", networkId: props.networkId, nick: value })
      .then((ok) => {
        if (ok) props.close();
      });
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
          <WhoisLookup
            user={snapshot()?.user}
            nick={nick()}
            onNick={setNick}
            request={requestUser}
            startConversation={startConversation}
          />
        }
      >
        <ChannelDirectory
          directory={snapshot()?.directory}
          filter={filter()}
          onFilter={setFilter}
          matches={matches()}
          refresh={() => {
            void props.dispatch({
              type: "irc.request",
              networkId: props.networkId,
              command: { type: "list" },
            });
          }}
          join={(channel) => void join(channel)}
        />
      </Show>
    </>
  );
}

function WhoisLookup(props: {
  user: DiscoverySnapshot["user"] | undefined;
  nick: string;
  onNick: (value: string) => void;
  request: () => void;
  startConversation: (nick: string) => void;
}) {
  const colors = usePalette();
  const loading = () => props.user?.state === "loading";
  return (
    <>
      <Field
        id="whois-nick"
        label="Look up a nickname"
        value={props.nick}
        onInput={props.onNick}
        onSubmit={props.request}
      />
      <Button
        id="whois-request"
        layer="modal"
        label={loading() ? "Looking up…" : "Look up person"}
        disabled={loading()}
        onPress={props.request}
      />
      <Show when={loading()}>
        <text fg={colors.muted}>Waiting for the network’s WHOIS response…</text>
      </Show>
      <Show when={props.user?.state === "idle"}>
        <text fg={colors.muted}>
          Enter a nickname and choose Look up person. The network may omit private details.
        </text>
      </Show>
      <Show when={props.user?.error}>
        <text fg={colors.error}>{props.user?.error?.message}</text>
      </Show>
      <Show when={props.user?.state === "ready" && props.user?.details}>
        {() => {
          const details = () => props.user?.details;
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
                  if (value) props.startConversation(value);
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
  );
}

function ChannelDirectory(props: {
  directory: DiscoverySnapshot["directory"] | undefined;
  filter: string;
  onFilter: (value: string) => void;
  matches: readonly ChannelListing[];
  refresh: () => void;
  join: (channel: string) => void;
}) {
  const colors = usePalette();
  const loading = () => props.directory?.state === "loading";
  return (
    <>
      <Field
        id="directory-filter"
        label="Filter channel names and topics locally"
        value={props.filter}
        onInput={props.onFilter}
        placeholder="Search this directory"
      />
      <Button
        id="directory-refresh"
        layer="modal"
        label={loading() ? "Receiving directory…" : "Request channel directory"}
        disabled={loading()}
        onPress={props.refresh}
      />
      <Show when={props.directory?.state === "idle"}>
        <text fg={colors.muted}>
          Choose Request channel directory to ask the network for public channels.
        </text>
      </Show>
      <Show when={props.directory?.error}>
        <text fg={colors.error}>{props.directory?.error?.message}</text>
      </Show>
      <Show when={props.directory?.truncated}>
        <text fg={colors.error}>
          The network directory exceeded the application limit. Some channels are omitted; you can
          still join a channel by name.
        </text>
      </Show>
      <text fg={colors.muted}>
        {props.matches.length} matches · displaying up to 100. Refine the filter to find more.{" "}
        {loading() ? "Results are still arriving." : ""}
      </text>
      <For each={props.matches.slice(0, 100)}>
        {(item, index) => (
          <box flexDirection="column" flexShrink={0}>
            <Button
              id={`directory-join-${index()}`}
              layer="modal"
              label={`Join ${item.channel} · ${item.userCount} people`}
              onPress={() => props.join(item.channel)}
            />
            <text fg={colors.muted}>{item.topic || "No topic provided"}</text>
          </box>
        )}
      </For>
      <Show when={props.directory?.state === "ready" && !props.matches.length}>
        <text fg={colors.muted}>
          No channels match. Try a shorter filter or join a known channel by name.
        </text>
      </Show>
    </>
  );
}
