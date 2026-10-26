import type { JsonObject, JsonValue } from "../contracts/control";
import { defaultTuiSettings, defaultUserSettings } from "../storage/settings";

const textPattern = "^[^\\u0000-\\u0008\\u000b-\\u001f\\u007f-\\u009f]*$";
const identifierPattern = "^[^\\s\\u0000-\\u001f\\u007f-\\u009f]+$";
const labelPattern =
  "^[^\\u0000-\\u001f\\u007f-\\u009f]*[^\\s\\u0000-\\u001f\\u007f-\\u009f][^\\u0000-\\u001f\\u007f-\\u009f]*$";
const secretPattern =
  "^(env:[A-Za-z_][A-Za-z0-9_]{0,255}|keychain:[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$";

function field(description: string, schema: JsonObject, effects: readonly string[]): JsonObject {
  return { description, ...schema, "x-effects": effects };
}
function object(
  description: string,
  properties: JsonObject,
  required = Object.keys(properties),
): JsonObject {
  return { type: "object", description, properties, required, additionalProperties: false };
}
function ref(name: string): JsonObject {
  return { $ref: `#/$defs/${name}` };
}
function array(items: JsonObject, maxItems: number, extra: JsonObject = {}): JsonObject {
  return { type: "array", items, maxItems, ...extra };
}

/** Discovery schema, not a replacement for storage/validation.ts or the effect planner. */
export function configurationSchema(): JsonObject {
  const user = defaultUserSettings();
  const tui = defaultTuiSettings();
  const immediate = ["immediate"];
  const reconnect = ["reconnect"];
  const userDefault: JsonObject = {
    schemaVersion: user.schemaVersion,
    networks: [],
    history: { ...user.history, excludedConversations: [] },
    notifications: { ...user.notifications },
    sendTyping: user.sendTyping,
  };
  const tuiDefault: JsonObject = { ...tui, keybindings: {} };
  const boolean = (description: string, value: boolean, effects = immediate): JsonObject =>
    field(description, { type: "boolean", default: value }, effects);
  const version = field(
    "Settings format version; only version 1 is supported.",
    { const: 1, type: "integer", default: 1 },
    [],
  );
  const identifier = { type: "string", minLength: 1, maxLength: 512, pattern: identifierPattern };
  const label = { type: "string", minLength: 1, maxLength: 512, pattern: labelPattern };
  const secret = field(
    "Secret reference only, never plaintext. Environment variable or opaque keychain ID; no credential retrieval method exists.",
    { type: "string", pattern: secretPattern, "x-secret-reference": true },
    reconnect,
  );
  const endpoint = object(
    "Ordered connection endpoint. Host is a bare hostname or IP address, not a URI or host:port.",
    {
      host: field(
        "Bare hostname, IPv4 or unbracketed IPv6; no URI, userinfo, path or embedded port. IPv6 is validated with node:net isIP.",
        {
          ...identifier,
          anyOf: [{ pattern: "^[^/:@\\[\\]]+$" }, { format: "ipv6" }],
          "x-runtime-validation":
            "IPv6 branch requires isIP(host) === 6 (format must be asserted by consumers).",
        },
        reconnect,
      ),
      port: field(
        "Explicit TCP port; no port resolution or inference.",
        { type: "integer", minimum: 1, maximum: 65535 },
        reconnect,
      ),
      tls: field(
        "Use verified TLS. Every endpoint must use TLS when SASL is configured.",
        { type: "boolean" },
        reconnect,
      ),
    },
  );
  const identity = object(
    "Identity for the next explicit connection; editing never reconnects automatically.",
    {
      nick: field(
        "Preferred nickname; must differ exactly from all alternate nicknames.",
        identifier,
        reconnect,
      ),
      alternateNicks: field(
        "Ordered fallback nicknames, distinct from the preferred nickname and each other.",
        array(identifier, 16, { uniqueItems: true }),
        reconnect,
      ),
      username: field("IRC username without whitespace or controls.", identifier, reconnect),
      realname: field(
        "IRC real name; may be empty, but cannot contain tabs, newlines or control characters.",
        {
          type: "string",
          maxLength: 512,
          pattern: "^[^\\u0000-\\u001f\\u007f-\\u009f]*$",
        },
        reconnect,
      ),
    },
  );
  const sasl = object("SASL PLAIN authentication; all endpoints must use verified TLS.", {
    mechanism: field(
      "Only SASL PLAIN is currently supported.",
      { type: "string", const: "PLAIN" },
      reconnect,
    ),
    account: field("Authentication account without whitespace or controls.", identifier, reconnect),
    password: secret,
    required: field(
      "Fail connection if authentication cannot complete when true.",
      { type: "boolean" },
      reconnect,
    ),
  });
  const join = object(
    "Channel to join on the next connection; duplicate exact channel names are forbidden.",
    {
      channel: field(
        "Channel name with #, &, + or ! prefix; no spaces, commas or colons.",
        { ...identifier, pattern: "^[#&+!][^\\s,:\\u0000-\\u001f\\u007f-\\u009f]+$" },
        reconnect,
      ),
      key: secret,
    },
    ["channel"],
  );
  const networkShape = object(
    "Saved network profile. Adding/removing a profile requires network permission; new autoConnect profiles can connect and removals disconnect. Existing profiles never reconnect implicitly.",
    {
      id: field(
        "Opaque unique network ID. Changing ID is removal plus addition, not a rename.",
        identifier,
        ["network"],
      ),
      name: field("Nonblank display label without tabs/newlines.", label, immediate),
      endpoints: field(
        "One to sixteen ordered endpoints; replaces the entire array on patch.",
        array(ref("endpoint"), 16, { minItems: 1 }),
        reconnect,
      ),
      identity: field("Connection identity.", ref("identity"), reconnect),
      serverPassword: secret,
      sasl: field(
        "Optional SASL settings. Remove with unset, not null. Requires TLS on every endpoint.",
        ref("sasl"),
        reconnect,
      ),
      autoConnect: field(
        "Connect at startup and when adding a new profile. Changing this on an existing profile does not immediately connect/disconnect.",
        { type: "boolean" },
        ["network"],
      ),
      autoJoin: field(
        "Up to 1000 channels with unique exact names. Editing applies on next explicit connection, not live joins.",
        array(ref("autoJoin"), 1000, { uniqueItems: true }),
        reconnect,
      ),
    },
    ["id", "name", "endpoints", "identity", "autoConnect", "autoJoin"],
  );
  const network: JsonObject = {
    ...networkShape,
    if: { required: ["sasl"] },
    // oxlint-disable-next-line unicorn/no-thenable -- JSON Schema conditional, not a promise.
    then: { properties: { endpoints: { items: { properties: { tls: { const: true } } } } } },
    "x-runtime-validation":
      "Unique ID across profiles; preferred/alternate nickname uniqueness; exact autoJoin channel uniqueness.",
  };
  const exclusionShape = object(
    "Exact history exclusion; no wildcard syntax. The network ID must exist in this document.",
    {
      networkId: field("Reference to an existing configured network ID.", identifier, immediate),
      kind: field(
        "Conversation kind.",
        { type: "string", enum: ["channel", "direct", "status"] },
        immediate,
      ),
      name: field(
        "Exact target name using network IRC casemapping. Status labels may contain spaces; channel/direct names cannot.",
        label,
        immediate,
      ),
    },
  );
  const exclusion: JsonObject = {
    ...exclusionShape,
    if: { properties: { kind: { enum: ["channel", "direct"] } } },
    // oxlint-disable-next-line unicorn/no-thenable -- JSON Schema conditional, not a promise.
    then: { properties: { name: identifier } },
  };
  const history = object(
    "History and draft persistence policy. Existing history is retained when disabling history or changing exclusions; deletion is explicit, except retention pruning.",
    {
      enabled: boolean(
        "Persist eligible messages; disabling does not delete existing history.",
        user.history.enabled,
      ),
      retentionDays: field(
        "Positive retention in days, or null to retain indefinitely. Shortening requires destructive permission and confirmation; applying may prune history.",
        {
          type: ["integer", "null"],
          minimum: 1,
          maximum: 36500,
          default: user.history.retentionDays,
        },
        ["immediate", "destructive"],
      ),
      excludedConversations: field(
        "Exact unique (networkId, kind, name) exclusions. Array patches replace all entries. Existing history is not deleted.",
        array(ref("historyExclusion"), 10000, { uniqueItems: true, default: [] }),
        immediate,
      ),
      persistDrafts: boolean(
        "Persist eligible drafts. Disabling clears persisted drafts, not conversation history.",
        user.history.persistDrafts,
      ),
    },
  );
  const notifications = object(
    "Notification policy; desktop support depends on platform availability.",
    {
      desktop: boolean("Enable supported desktop notifications.", user.notifications.desktop),
      previews: boolean(
        "Include message previews in notifications (privacy-sensitive).",
        user.notifications.previews,
      ),
      bell: boolean("Enable terminal bell notifications where supported.", user.notifications.bell),
    },
  );
  const userSchema = {
    ...object("User settings stored atomically as one section.", {
      schemaVersion: version,
      networks: field(
        "At most 100 profiles with unique exact IDs. Arrays replace, not merge by ID.",
        array(ref("networkProfile"), 100, { default: [] }),
        ["immediate", "network", "reconnect"],
      ),
      history: field(
        "History retention, exclusions and drafts.",
        { ...ref("history"), default: userDefault.history! },
        immediate,
      ),
      notifications: field(
        "Desktop, preview and bell policy.",
        { ...ref("notifications"), default: userDefault.notifications! },
        immediate,
      ),
      sendTyping: boolean(
        "Send typing notifications only when negotiated with the server.",
        user.sendTyping,
      ),
    }),
    default: userDefault,
  };
  const tuiSchema = {
    ...object("Terminal UI settings stored atomically as one section.", {
      schemaVersion: version,
      theme: field(
        "Live color theme.",
        { type: "string", enum: ["dark", "light", "high-contrast"], default: tui.theme },
        immediate,
      ),
      mouse: boolean(
        "Renderer mouse support; restart required because live reconfiguration is not supported.",
        tui.mouse,
        ["restart"],
      ),
      density: field(
        "Live conversation layout density.",
        { type: "string", enum: ["comfortable", "compact"], default: tui.density },
        immediate,
      ),
      memberList: boolean("Show the live channel member panel.", tui.memberList),
      showHistServ: boolean(
        "Show messages from the HistServ nickname in the transcript; hidden by default, never deleted from history/search/control reads.",
        tui.showHistServ,
      ),
      sidebarWidth: field(
        "Live sidebar width in terminal cells; also adjustable by dragging its divider.",
        { type: "integer", minimum: 12, maximum: 80, default: tui.sidebarWidth },
        immediate,
      ),
      memberListWidth: field(
        "Live channel member panel width in terminal cells; also adjustable by dragging its divider.",
        { type: "integer", minimum: 12, maximum: 60, default: tui.memberListWidth },
        immediate,
      ),
      authorColumnWidth: field(
        "Transcript time/author column width in terminal cells, or null to fit the longest visible nickname; also adjustable by dragging the transcript divider.",
        { type: ["integer", "null"], minimum: 8, maximum: 40, default: tui.authorColumnWidth },
        immediate,
      ),
      keybindings: field(
        "Reserved; UI does not implement custom shortcuts. Changed nonempty maps are rejected as unsupported; unchanged legacy maps are preserved. Empty maps may be stored but do not rebind the UI. Shortcuts must be globally unique ignoring case.",
        {
          type: "object",
          maxProperties: 200,
          default: {},
          propertyNames: {
            ...identifier,
            not: { enum: ["__proto__", "prototype", "constructor"] },
          },
          additionalProperties: array(identifier, 10, { uniqueItems: true }),
          "x-runtime-validation":
            "Global case-insensitive shortcut uniqueness; prototype-related keys are forbidden by control input validation.",
        },
        ["unsupported"],
      ),
    }),
    default: tuiDefault,
  };
  const definitions: Record<string, JsonValue> = {
    user: userSchema,
    tui: tuiSchema,
    networkProfile: network,
    endpoint,
    identity,
    sasl,
    autoJoin: join,
    historyExclusion: exclusion,
    history,
    notifications,
    secretReference: secret,
  };
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: "https://openirc.local/schemas/settings-v1.json",
    title: "OpenIRC SettingsDocument",
    ...object(
      "Revisioned settings. Revisions are opaque read-only CAS tokens covering both files, not editable settings.",
      {
        revision: field(
          "Read-only revision from storage; submit as expectedRevision when applying a plan. A plan performs no IO and cannot guarantee a later CAS succeeds.",
          { type: "string", minLength: 1, readOnly: true },
          [],
        ),
        user: ref("user"),
        tui: ref("tui"),
      },
    ),
    $defs: definitions,
    "x-control": {
      edit: "Exactly one section per edit: {section,value} OR {section,patch,unset?}. Deep object patches, array replacement, literal null. No default injection.",
      unset:
        "Dot paths relative to the section. Decimal array indices may traverse arrays but array elements cannot be removed. Only optional properties can be removed; final storage validation is authoritative.",
      limits: {
        maxConfigBytes: 1048576,
        maxEditBytes: 1048576,
        maxDepth: 32,
        maxNodes: 100000,
        maxUnsetPaths: 1000,
      },
      permissions: {
        base: ["configure"],
        network: "Profile additions/removals or autoConnect changes.",
        destructive:
          "Shortening retention, including indefinite to finite; caller must also confirm.",
      },
      reconnect:
        "Existing endpoint/identity/credential/autojoin edits report network IDs; never silently reconnect or replay sends.",
      secrets:
        "References only; no resolve/get method. Error messages never echo supplied values or credentials.",
      validation:
        "storage/validation.ts is authoritative. Additional semantic checks: unique network IDs, nick/alternate uniqueness, unique autoJoin channels, exclusion foreign keys/tuple uniqueness, global case-insensitive shortcuts, SASL requires TLS. Hosts require isIP or absence of URI delimiters. Runtime string lengths use UTF-16 code units (JSON Schema uses code points); lone surrogates are rejected. The control boundary also rejects C0/C1 controls (including terminal line breaks) and lone surrogates in every input string, including references. Prototype-related keys are forbidden at any depth. Configuration size includes pretty-printed JSON, while persisted JSONC/comments can still exceed storage limits.",
    },
    "x-text-policy": {
      pattern: textPattern,
      description:
        "No C0 controls except tab/LF for general text; settings fields impose stricter per-field patterns. No C1 controls or lone surrogates.",
    },
  };
}
