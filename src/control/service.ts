import { createHash } from "node:crypto";
import type { AppApi } from "../contracts/app";
import type { ConfigRevision, Result } from "../contracts/common";
import type {
  ControlError,
  ControlHandler,
  ControlMethod,
  ControlPermission,
  ControlRequest,
  ControlResponse,
  JsonObject,
  JsonValue,
} from "../contracts/control";
import {
  ALL_CONTROL_PERMISSIONS,
  CONTROL_METHODS,
  DEFAULT_CONTROL_PERMISSIONS,
} from "../contracts/control";
import type {
  SecretProvider,
  SettingsChange,
  SettingsDocument,
  SettingsRepository,
} from "../contracts/settings";
import type { SearchQuery } from "../contracts/storage";
import { secretReference } from "../storage/validation";
import { actionSchema, parseAppAction, permissionsForAction } from "./actions";
import { parseConfigEdit, prepareConfigChange } from "./config";
import { configurationSchema } from "./schema";
import { parseControlRequest } from "./protocol";
import {
  boolean,
  ControlFault,
  fail,
  fields,
  integer,
  json,
  object,
  opaqueId,
  string,
} from "./validation";

export interface ControlServiceOptions {
  readonly settings: SettingsRepository;
  readonly secrets: SecretProvider;
  readonly app?: AppApi;
  readonly permissions?: readonly ControlPermission[];
  readonly now?: () => number;
}
const SUCCESS = (id: string, result: unknown): ControlResponse => ({
  version: 1,
  id,
  ok: true,
  result: json(result),
});
const FAILURE = (id: string, detail: ControlError): ControlResponse => ({
  version: 1,
  id,
  ok: false,
  error: detail,
});
const unwrap = <T>(result: Result<T, ControlError>): T => {
  // App/adapter errors can originate in remote IRC replies. Never turn their free-form
  // messages into an inspect/configure side channel for message bodies or credentials.
  if (!result.ok)
    throw new ControlFault({
      code: result.error.code,
      message: "The requested operation could not be completed.",
      retryable: result.error.retryable,
      ...(result.error.outcome ? { outcome: result.error.outcome } : {}),
    });
  return result.value;
};
const REPLAY_TTL_MS = 120000;
const REPLAY_LIMIT = 256;
const REPLAY_MAX_BYTES = 16 * 1024 * 1024;
const MAX_INFLIGHT = 32;

/** The business/control boundary. All live actions delegate to the existing AppApi. */
export function createControlService(options: ControlServiceOptions): ControlHandler {
  const allowed = [...(options.permissions ?? DEFAULT_CONTROL_PERMISSIONS)];
  const now = options.now ?? Date.now;
  const cache = new Map<
    string,
    {
      fingerprint: string;
      promise: Promise<ControlResponse>;
      expires: number;
      pending: boolean;
      bytes: number;
    }
  >();
  let replayBytes = 0;
  const removeReplay = (id: string) => {
    replayBytes -= cache.get(id)?.bytes ?? 0;
    cache.delete(id);
  };
  const live = () => {
    if (!options.app) fail("unavailable", "This command needs a running opentui-irc instance.");
    return options.app;
  };
  const requireRights = (request: ControlRequest, rights: readonly ControlPermission[]) => {
    if (rights.some((right) => !allowed.includes(right) || !request.permissions.includes(right)))
      fail(
        "permission-denied",
        "This operation requires explicitly requested permissions granted by the running server. Inspect capabilities before retrying.",
      );
  };
  const confirm = (value: unknown) => {
    if (value !== true)
      fail("permission-denied", "This destructive operation requires explicit confirmation.");
  };
  const settings = async (signal: AbortSignal): Promise<SettingsDocument> => {
    const current = options.app?.settings.getSnapshot();
    return current ?? unwrap(await options.settings.load(signal));
  };
  const checkRevision = (document: SettingsDocument, value: unknown) => {
    const expected = opaqueId<"config-revision">(value);
    if (expected !== document.revision)
      fail(
        "conflict",
        "Settings changed after inspection; get and plan the current revision again.",
      );
    return expected;
  };
  /** Parameterless read-only methods share the same admission checks. */
  const inspect = (request: ControlRequest) => {
    fields(request.params, []);
    requireRights(request, ["inspect"]);
  };
  const confirmFlag = (params: Record<string, unknown>) => {
    if (params.confirm !== undefined) boolean(params.confirm);
  };
  /** Validate and plan a config edit against the current read model. */
  const planConfig = async (request: ControlRequest, signal: AbortSignal) => {
    const params = fields(request.params, ["edit", "expectedRevision"], ["confirm"]);
    confirmFlag(params);
    requireRights(request, ["inspect"]);
    const current = await settings(signal);
    const expected = checkRevision(current, params.expectedRevision);
    const edit = unwrap(parseConfigEdit(params.edit));
    const plan = unwrap(prepareConfigChange(current, edit));
    return { params, expected, plan };
  };
  const saveConfig = async (
    change: SettingsChange,
    expected: ConfigRevision,
    signal: AbortSignal,
  ): Promise<{ saved: SettingsDocument; operationId?: string }> => {
    if (!options.app)
      return { saved: unwrap(await options.settings.save(change, expected, signal)) };
    const operationId = unwrap(await options.app.saveSettings(change, expected, signal));
    const saved = options.app.settings.getSnapshot();
    if (!saved) fail("unavailable", "Settings are not ready.");
    return { saved, operationId };
  };
  const applyConfig = async (request: ControlRequest, signal: AbortSignal) => {
    const { params, expected, plan } = await planConfig(request, signal);
    requireRights(request, ["configure", ...plan.requiredPermissions]);
    if (plan.requiredPermissions.includes("destructive")) confirm(params.confirm);
    // Even a no-op must not accidentally ignore external file changes hidden by the live read model.
    checkRevision(unwrap(await options.settings.load(signal)), expected);
    if (signal.aborted) fail("cancelled", "Control request cancelled before save.");
    // Planning must still describe the live base after an asynchronous disk check.
    if (options.app) {
      const liveSettings = options.app.settings.getSnapshot();
      if (!liveSettings) fail("unavailable", "Settings are not ready.");
      checkRevision(liveSettings, expected);
    }
    if (!plan.changed) return { applied: false, revision: expected, plan };
    const { saved, operationId } = await saveConfig(plan.change, expected, signal);
    return {
      applied: true,
      revision: saved.revision,
      plan,
      ...(operationId ? { operationId } : {}),
    };
  };
  const reloadConfig = async (request: ControlRequest, signal: AbortSignal) => {
    const params = fields(request.params, [], ["dryRun", "expectedRevision", "confirm"]);
    confirmFlag(params);
    if (params.dryRun !== undefined) boolean(params.dryRun);
    requireRights(request, ["inspect"]);
    const disk = unwrap(await options.settings.load(signal));
    if (signal.aborted) fail("cancelled", "Control request cancelled before reload.");
    if (!options.app) return { applied: false, revision: disk.revision, mode: "offline" };
    const current = await settings(signal);
    const plans = [
      unwrap(prepareConfigChange(current, { section: "user", value: jsonObjectCopy(disk.user) })),
      unwrap(prepareConfigChange(current, { section: "tui", value: jsonObjectCopy(disk.tui) })),
    ];
    if (params.dryRun === true)
      return { revision: disk.revision, liveRevision: current.revision, plans };
    if (params.dryRun !== undefined) boolean(params.dryRun);
    checkRevision(disk, params.expectedRevision);
    const rights = [...new Set(plans.flatMap((plan) => plan.requiredPermissions))];
    requireRights(request, ["configure", ...rights]);
    if (rights.includes("destructive")) confirm(params.confirm);
    if (signal.aborted) fail("cancelled", "Control request cancelled before reload.");
    const operationId = unwrap(
      await options.app.reloadSettings(disk.revision, current.revision, signal),
    );
    return { applied: true, revision: disk.revision, plans, operationId };
  };
  const searchQuery = (params: Record<string, unknown>): SearchQuery => ({
    text: string(params.text, 4096),
    limit: params.limit === undefined ? 50 : integer(params.limit, 1, 100),
    ...(params.networkId !== undefined ? { networkId: opaqueId<"network">(params.networkId) } : {}),
    ...(params.conversationId !== undefined
      ? { conversationId: opaqueId<"conversation">(params.conversationId) }
      : {}),
    ...(params.sender !== undefined ? { sender: string(params.sender, 512) } : {}),
    ...(params.after !== undefined
      ? { after: integer(params.after, 0, Number.MAX_SAFE_INTEGER) }
      : {}),
    ...(params.before !== undefined
      ? { before: integer(params.before, 0, Number.MAX_SAFE_INTEGER) }
      : {}),
    ...(params.cursor !== undefined ? { cursor: opaqueId<"cursor">(params.cursor, 16384) } : {}),
  });
  const storeSecret = async (value: string, signal: AbortSignal) =>
    options.app
      ? unwrap(await options.app.storeSecret(value, signal))
      : unwrap(await options.secrets.store(value, signal));
  /** One handler per method; each returns the result payload or throws a ControlFault. */
  const handlers: Readonly<
    Record<ControlMethod, (request: ControlRequest, signal: AbortSignal) => Promise<unknown>>
  > = {
    capabilities: async (request) => {
      fields(request.params, []);
      return {
        protocolVersion: 1,
        mode: options.app ? "live" : "offline",
        permissions: allowed,
        availablePermissions: ALL_CONTROL_PERMISSIONS,
        methods: CONTROL_METHODS,
        limits: {
          maxRequestBytes: 1048576,
          maxResponseBytes: 4194304,
          replayEntries: REPLAY_LIMIT,
          replayMaxBytes: REPLAY_MAX_BYTES,
          replayTtlMs: REPLAY_TTL_MS,
          replayDurable: false,
        },
        schemas: { settings: configurationSchema(), action: actionSchema() },
        notes: [
          "Secret references are visible; resolved credentials are never returned.",
          "Local configure plus network authority can repoint a credential reference to another host and connect. This is same-UID consent, not a secret-vault sandbox.",
          "Message/draft reads, sends, and destructive work require separate explicit permissions.",
          "No automatic mutation retries. Replay protection is bounded and not durable across restart.",
          "Offline mode never connects to IRC or opens local message history.",
        ],
      };
    },
    "config.schema": async (request) => {
      fields(request.params, []);
      return configurationSchema();
    },
    status: async (request) => {
      inspect(request);
      const state = options.app?.state.getSnapshot();
      return {
        running: !!state,
        boot: state?.boot ?? "offline",
        revision: state?.revision ?? 0,
        networks:
          state?.networks.map(({ lastError, ...network }) => ({
            ...network,
            ...(lastError ? { errorCode: lastError.code } : {}),
          })) ?? [],
        activeConversationId: state?.activeConversationId ?? null,
        ...(state?.error ? { errorCode: state.error.code } : {}),
        permissions: allowed,
      };
    },
    "config.get": async (request, signal) => {
      inspect(request);
      return settings(signal);
    },
    "config.plan": async (request, signal) => (await planConfig(request, signal)).plan,
    "config.apply": applyConfig,
    "config.reload": reloadConfig,
    "networks.list": async (request, signal) => {
      inspect(request);
      return (await settings(signal)).user.networks;
    },
    "conversations.list": async (request) => {
      inspect(request);
      return live()
        .state.getSnapshot()
        .conversations.map(({ topic: _topic, ...conversation }) => conversation);
    },
    "operations.list": async (request) => {
      inspect(request);
      return live()
        .operations.getSnapshot()
        .map(({ error, ...operation }) => ({
          ...operation,
          ...(error ? { errorCode: error.code } : {}),
        }));
    },
    "action.dispatch": async (request, signal) => {
      const params = fields(request.params, ["action"], ["confirm"]);
      confirmFlag(params);
      const action = unwrap(parseAppAction(params.action));
      const rights = permissionsForAction(action);
      requireRights(request, rights);
      if (rights.includes("destructive")) confirm(params.confirm);
      return unwrap(await live().dispatch(action, signal));
    },
    "timeline.get": async (request) => {
      const params = fields(request.params, ["conversationId"]);
      requireRights(request, ["read-messages"]);
      return unwrap(live().timeline(opaqueId<"conversation">(params.conversationId))).getSnapshot();
    },
    "history.search": async (request, signal) => {
      const params = fields(
        request.params,
        ["text"],
        ["networkId", "conversationId", "sender", "after", "before", "cursor", "limit"],
      );
      requireRights(request, ["read-messages"]);
      return unwrap(await live().search(searchQuery(params), signal));
    },
    "discovery.get": async (request) => {
      const params = fields(request.params, ["networkId"]);
      requireRights(request, ["inspect"]);
      const snapshot = unwrap(
        live().discovery(opaqueId<"network">(params.networkId)),
      ).getSnapshot();
      const { error: directoryError, ...directory } = snapshot.directory;
      const { error: userError, ...user } = snapshot.user;
      return {
        networkId: snapshot.networkId,
        directory: {
          ...directory,
          ...(directoryError ? { errorCode: directoryError.code } : {}),
        },
        user: { ...user, ...(userError ? { errorCode: userError.code } : {}) },
      };
    },
    "secrets.store": async (request, signal) => {
      const params = fields(request.params, ["value"]);
      requireRights(request, ["configure"]);
      const value = string(params.value, 65536);
      if (!value || Buffer.byteLength(value) > 65536)
        fail("invalid-input", "Credential input must contain 1–65536 UTF-8 bytes.");
      const reference = await storeSecret(value, signal);
      if (!secretReference(reference))
        fail("internal", "Secret storage did not return a valid reference.");
      return { reference };
    },
    "app.shutdown": async (request) => {
      const params = fields(request.params, ["confirm"]);
      requireRights(request, ["destructive"]);
      confirm(params.confirm);
      live();
      // Composition root acts only after the socket response is flushed.
      return { accepted: true };
    },
  };
  const execute = async (
    request: ControlRequest,
    signal: AbortSignal,
  ): Promise<ControlResponse> => {
    try {
      if (signal.aborted) fail("cancelled", "Control request cancelled before admission.");
      return SUCCESS(request.id, await handlers[request.method](request, signal));
    } catch (cause) {
      const detail: ControlError =
        cause instanceof ControlFault
          ? cause.detail
          : { code: "internal", message: "The control operation failed safely.", retryable: false };
      return FAILURE(request.id, detail);
    }
  };
  const ownedResponse = (response: ControlResponse): ControlResponse =>
    response.ok
      ? { ...response, result: json(response.result) }
      : { ...response, error: { ...response.error } };
  return async (request, signal) => {
    // Validate and detach even when invoked without the Unix transport. Mutable caller
    // data must never diverge from the payload/intent admitted into the replay cache.
    let input: ControlRequest;
    try {
      const parsed = parseControlRequest(request);
      if (!parsed.ok) throw new ControlFault(parsed.error);
      input = {
        ...parsed.value,
        params: jsonObjectCopy(parsed.value.params),
        permissions: [...parsed.value.permissions],
      };
      if (Buffer.byteLength(JSON.stringify(input)) > 1048576)
        fail("protocol", "Control request exceeds its size limit.");
    } catch {
      return FAILURE("invalid-request", {
        code: "protocol",
        message: "Unsupported control request.",
        retryable: false,
      });
    }
    if (signal.aborted)
      return FAILURE(input.id, {
        code: "cancelled",
        message: "Request cancelled before admission.",
        retryable: false,
      });
    for (const [id, entry] of cache) if (!entry.pending && entry.expires <= now()) removeReplay(id);
    const canonical = JSON.stringify(
      [input.method, input.params, [...input.permissions].sort()],
      (_key, value: unknown) =>
        object(value)
          ? Object.fromEntries(
              Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
            )
          : value,
    );
    const fingerprint = createHash("sha256").update(canonical).digest("hex");
    const prior = cache.get(input.id);
    // IDs cover reads as well as writes: changing method, payload or rights cannot reuse
    // another request's cached result or silently perform a different operation.
    if (prior)
      return prior.fingerprint === fingerprint
        ? ownedResponse(await prior.promise)
        : FAILURE(input.id, {
            code: "conflict",
            message: "Request ID was already used for a different operation.",
            retryable: false,
          });
    if ([...cache.values()].filter((entry) => entry.pending).length >= MAX_INFLIGHT)
      return FAILURE(input.id, {
        code: "rate-limited",
        message: "Too many control operations are pending.",
        retryable: false,
      });
    while (cache.size >= REPLAY_LIMIT) {
      const removable = [...cache].find(([, entry]) => !entry.pending);
      if (!removable) break;
      removeReplay(removable[0]);
    }
    // Install the promise before entering app/adapter code, including reentrant ports.
    const promise = Promise.resolve().then(() => execute(input, signal));
    const entry = { fingerprint, promise, expires: now() + REPLAY_TTL_MS, pending: true, bytes: 0 };
    cache.set(input.id, entry);
    void promise.then((response) => {
      entry.pending = false;
      entry.expires = now() + REPLAY_TTL_MS;
      entry.bytes = Buffer.byteLength(JSON.stringify(response));
      replayBytes += entry.bytes;
      while (replayBytes > REPLAY_MAX_BYTES) {
        const removable = [...cache].find(([, cached]) => !cached.pending);
        if (!removable) break;
        removeReplay(removable[0]);
      }
    });
    return ownedResponse(await promise);
  };
}

function jsonObjectCopy(value: unknown): JsonObject {
  const copied: JsonValue = json(value);
  if (copied === null || typeof copied !== "object" || Array.isArray(copied))
    fail("internal", "Invalid configuration document.");
  // JSON copy of a validated document section has string keys and JSON values.
  return Object.fromEntries(Object.entries(copied));
}
