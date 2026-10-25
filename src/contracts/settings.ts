import type { ConfigRevision, NetworkId, Result, SecretRef } from "./common";

export interface NetworkProfile {
  readonly id: NetworkId;
  readonly name: string;
  readonly endpoints: readonly {
    readonly host: string;
    readonly port: number;
    readonly tls: boolean;
  }[];
  readonly identity: {
    readonly nick: string;
    readonly alternateNicks: readonly string[];
    readonly username: string;
    readonly realname: string;
  };
  readonly serverPassword?: SecretRef;
  readonly sasl?: {
    readonly mechanism: "PLAIN";
    readonly account: string;
    readonly password: SecretRef;
    readonly required: boolean;
  };
  readonly autoConnect: boolean;
  readonly autoJoin: readonly { readonly channel: string; readonly key?: SecretRef }[];
}

export interface UserSettings {
  readonly schemaVersion: 1;
  readonly networks: readonly NetworkProfile[];
  readonly history: {
    readonly enabled: boolean;
    /** null means retain indefinitely; zero is invalid. The current default is 30 days. */
    readonly retentionDays: number | null;
    /** Exact target names using the network's IRC casemapping; no wildcard language in revision 1. */
    readonly excludedConversations: readonly {
      readonly networkId: NetworkId;
      readonly kind: "channel" | "direct" | "status";
      readonly name: string;
    }[];
    readonly persistDrafts: boolean;
  };
  readonly notifications: {
    readonly desktop: boolean;
    readonly previews: boolean;
    readonly bell: boolean;
  };
  readonly sendTyping: boolean;
}

export interface TuiSettings {
  readonly schemaVersion: 1;
  readonly theme: "dark" | "light" | "high-contrast";
  readonly mouse: boolean;
  readonly density: "comfortable" | "compact";
  readonly memberList: boolean;
  /** Presentation only; history/search/control retain service messages. Defaults false. */
  readonly showHistServ: boolean;
  readonly sidebarWidth: number;
  readonly keybindings: Readonly<Record<string, readonly string[]>>;
}

export interface SettingsDocument {
  readonly revision: ConfigRevision;
  readonly user: UserSettings;
  readonly tui: TuiSettings;
}

export type SettingsChange =
  | { readonly section: "user"; readonly value: UserSettings }
  | { readonly section: "tui"; readonly value: TuiSettings };

/** App owns semantic validation; adapter validates schema and atomic/conflict-safe persistence. */
export interface SettingsRepository {
  load(signal: AbortSignal): Promise<Result<SettingsDocument>>;
  /** Optimistic revision check then atomic one-file save; see CONTRACTS.md for external-writer races. */
  save(
    next: SettingsChange,
    expectedRevision: ConfigRevision,
    signal: AbortSignal,
  ): Promise<Result<SettingsDocument>>;
}

/** Private infrastructure port. Resolved strings must not enter snapshots/events/diagnostics. */
export interface SecretProvider {
  resolve(reference: SecretRef, signal: AbortSignal): Promise<Result<string>>;
  /** Store securely or return unsupported; never silently write plaintext settings. */
  store(value: string, signal: AbortSignal): Promise<Result<SecretRef>>;
}
