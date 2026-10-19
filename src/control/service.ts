import { createHash } from "node:crypto";
import type { AppApi } from "../contracts/app";
import type { Result } from "../contracts/common";
import type {
  ControlError,
  ControlHandler,
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
import type { SecretProvider, SettingsDocument, SettingsRepository } from "../contracts/settings";
import type { SearchQuery } from "../contracts/storage";
import { actionSchema, parseAppAction, permissionsForAction } from "./actions";
import { parseConfigEdit, prepareConfigChange } from "./config";
import { configurationSchema } from "./schema";
import { boolean, ControlFault, fail, fields, integer, json, opaqueId, string } from "./validation";

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
  if (!result.ok) throw new ControlFault(result.error);
  return result.value;
};
const MUTATIONS = new Set([
  "config.apply",
  "config.reload",
  "action.dispatch",
  "secrets.store",
  "app.shutdown",
]);
const REPLAY_TTL_MS = 120000;
const REPLAY_LIMIT = 256;
const MAX_INFLIGHT = 32;

/** The business/control boundary. All live actions delegate to the existing AppApi. */
export function createControlService(options: ControlServiceOptions): ControlHandler {
  const allowed = [...(options.permissions ?? DEFAULT_CONTROL_PERMISSIONS)];
  const now = options.now ?? Date.now;
  const cache = new Map<
    string,
    { fingerprint: string; promise: Promise<ControlResponse>; expires: number; pending: boolean }
  >();
  const live = () => {
    if (!options.app) fail("unavailable", "This command needs a running OpenIRC instance.");
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
  const execute = async (
    request: ControlRequest,
    signal: AbortSignal,
  ): Promise<ControlResponse> => {
    try {
      if (signal.aborted) fail("cancelled", "Control request cancelled before admission.");
      switch (request.method) {
        case "capabilities": {
          fields(request.params, []);
          return SUCCESS(request.id, {
            protocolVersion: 1,
            mode: options.app ? "live" : "offline",
            permissions: allowed,
            availablePermissions: ALL_CONTROL_PERMISSIONS,
            methods: CONTROL_METHODS,
            limits: {
              maxRequestBytes: 1048576,
              maxResponseBytes: 4194304,
              replayEntries: REPLAY_LIMIT,
              replayTtlMs: REPLAY_TTL_MS,
              replayDurable: false,
            },
            schemas: { settings: configurationSchema(), action: actionSchema() },
            notes: [
              "Secret references are visible; resolved credentials are never returned.",
              "Message/draft reads, sends, and destructive work require separate explicit permissions.",
              "No automatic mutation retries. Replay protection is bounded and not durable across restart.",
              "Offline mode never connects to IRC or opens local message history.",
            ],
          });
        }
        case "config.schema":
          fields(request.params, []);
          return SUCCESS(request.id, configurationSchema());
        case "status": {
          fields(request.params, []);
          requireRights(request, ["inspect"]);
          const state = options.app?.state.getSnapshot();
          return SUCCESS(request.id, {
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
          });
        }
        case "config.get":
          fields(request.params, []);
          requireRights(request, ["inspect"]);
          return SUCCESS(request.id, await settings(signal));
        case "config.plan":
        case "config.apply": {
          const params = fields(request.params, ["edit", "expectedRevision"], ["confirm"]);
          if (params.confirm !== undefined) boolean(params.confirm);
          requireRights(request, ["inspect"]);
          const current = await settings(signal);
          const expected = checkRevision(current, params.expectedRevision);
          const edit = unwrap(parseConfigEdit(params.edit));
          const plan = unwrap(prepareConfigChange(current, edit));
          if (request.method === "config.plan") return SUCCESS(request.id, plan);
          requireRights(request, ["configure", ...plan.requiredPermissions]);
          if (plan.requiredPermissions.includes("destructive")) confirm(params.confirm);
          // Even a no-op must not accidentally ignore external file changes hidden by the live read model.
          checkRevision(unwrap(await options.settings.load(signal)), expected);
          if (!plan.changed)
            return SUCCESS(request.id, { applied: false, revision: expected, plan });
          let operationId: string | undefined;
          let saved: SettingsDocument;
          if (options.app) {
            operationId = unwrap(await options.app.saveSettings(plan.change, expected, signal));
            const current = options.app.settings.getSnapshot();
            if (!current) fail("unavailable", "Settings are not ready.");
            saved = current;
          } else saved = unwrap(await options.settings.save(plan.change, expected, signal));
          return SUCCESS(request.id, {
            applied: true,
            revision: saved.revision,
            plan,
            ...(operationId ? { operationId } : {}),
          });
        }
        case "config.reload": {
          const params = fields(request.params, [], ["dryRun", "expectedRevision", "confirm"]);
          if (params.confirm !== undefined) boolean(params.confirm);
          if (params.dryRun !== undefined) boolean(params.dryRun);
          requireRights(request, ["inspect"]);
          const disk = unwrap(await options.settings.load(signal));
          if (!options.app)
            return SUCCESS(request.id, {
              applied: false,
              revision: disk.revision,
              mode: "offline",
            });
          const current = await settings(signal);
          const plans = [
            unwrap(
              prepareConfigChange(current, { section: "user", value: jsonObjectCopy(disk.user) }),
            ),
            unwrap(
              prepareConfigChange(current, { section: "tui", value: jsonObjectCopy(disk.tui) }),
            ),
          ];
          if (params.dryRun === true)
            return SUCCESS(request.id, {
              revision: disk.revision,
              liveRevision: current.revision,
              plans,
            });
          if (params.dryRun !== undefined) boolean(params.dryRun);
          checkRevision(disk, params.expectedRevision);
          const rights = [...new Set(plans.flatMap((plan) => plan.requiredPermissions))];
          requireRights(request, ["configure", ...rights]);
          if (rights.includes("destructive")) confirm(params.confirm);
          const operationId = unwrap(await options.app.reloadSettings(disk.revision, signal));
          return SUCCESS(request.id, {
            applied: true,
            revision: disk.revision,
            plans,
            operationId,
          });
        }
        case "networks.list": {
          fields(request.params, []);
          requireRights(request, ["inspect"]);
          return SUCCESS(request.id, (await settings(signal)).user.networks);
        }
        case "conversations.list": {
          fields(request.params, []);
          requireRights(request, ["inspect"]);
          return SUCCESS(
            request.id,
            live()
              .state.getSnapshot()
              .conversations.map(({ topic: _topic, ...conversation }) => conversation),
          );
        }
        case "operations.list": {
          fields(request.params, []);
          requireRights(request, ["inspect"]);
          return SUCCESS(
            request.id,
            live()
              .operations.getSnapshot()
              .map(({ error, ...operation }) => ({
                ...operation,
                ...(error ? { errorCode: error.code } : {}),
              })),
          );
        }
        case "action.dispatch": {
          const params = fields(request.params, ["action"], ["confirm"]);
          if (params.confirm !== undefined) boolean(params.confirm);
          const action = unwrap(parseAppAction(params.action));
          const rights = permissionsForAction(action);
          requireRights(request, rights);
          if (rights.includes("destructive")) confirm(params.confirm);
          return SUCCESS(request.id, unwrap(await live().dispatch(action, signal)));
        }
        case "timeline.get": {
          const params = fields(request.params, ["conversationId"]);
          requireRights(request, ["read-messages"]);
          return SUCCESS(
            request.id,
            unwrap(live().timeline(opaqueId<"conversation">(params.conversationId))).getSnapshot(),
          );
        }
        case "history.search": {
          const params = fields(
            request.params,
            ["text"],
            ["networkId", "conversationId", "sender", "after", "before", "cursor", "limit"],
          );
          requireRights(request, ["read-messages"]);
          const query: SearchQuery = {
            text: string(params.text, 4096),
            limit: params.limit === undefined ? 50 : integer(params.limit, 1, 100),
            ...(params.networkId !== undefined
              ? { networkId: opaqueId<"network">(params.networkId) }
              : {}),
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
            ...(params.cursor !== undefined
              ? { cursor: opaqueId<"cursor">(params.cursor, 16384) }
              : {}),
          };
          return SUCCESS(request.id, unwrap(await live().search(query, signal)));
        }
        case "discovery.get": {
          const params = fields(request.params, ["networkId"]);
          requireRights(request, ["inspect"]);
          return SUCCESS(
            request.id,
            unwrap(live().discovery(opaqueId<"network">(params.networkId))).getSnapshot(),
          );
        }
        case "secrets.store": {
          const params = fields(request.params, ["value"]);
          requireRights(request, ["configure"]);
          const value = string(params.value, 65536);
          if (!value || Buffer.byteLength(value) > 65536)
            fail("invalid-input", "Credential input must contain 1–65536 UTF-8 bytes.");
          const reference = options.app
            ? unwrap(await options.app.storeSecret(value, signal))
            : unwrap(await options.secrets.store(value, signal));
          return SUCCESS(request.id, { reference });
        }
        case "app.shutdown": {
          const params = fields(request.params, ["confirm"]);
          requireRights(request, ["destructive"]);
          confirm(params.confirm);
          live();
          // Composition root acts only after the socket response is flushed.
          return SUCCESS(request.id, { accepted: true });
        }
      }
    } catch (cause) {
      const detail: ControlError =
        cause instanceof ControlFault
          ? cause.detail
          : { code: "internal", message: "The control operation failed safely.", retryable: false };
      return FAILURE(request.id, detail);
    }
  };
  return async (request, signal) => {
    if (
      request.version !== 1 ||
      !CONTROL_METHODS.includes(request.method) ||
      !Array.isArray(request.permissions) ||
      request.permissions.some((right) => !ALL_CONTROL_PERMISSIONS.includes(right))
    )
      return FAILURE(request.id, {
        code: "protocol",
        message: "Unsupported control request.",
        retryable: false,
      });
    if (!MUTATIONS.has(request.method)) return execute(request, signal);
    if (signal.aborted)
      return FAILURE(request.id, {
        code: "cancelled",
        message: "Request cancelled before admission.",
        retryable: false,
      });
    for (const [id, entry] of cache) if (!entry.pending && entry.expires <= now()) cache.delete(id);
    const fingerprint = createHash("sha256")
      .update(JSON.stringify([request.method, request.params, request.permissions]))
      .digest("hex");
    const prior = cache.get(request.id);
    if (prior)
      return prior.fingerprint === fingerprint
        ? prior.promise
        : FAILURE(request.id, {
            code: "conflict",
            message: "Request ID was already used for a different operation.",
            retryable: false,
          });
    if ([...cache.values()].filter((entry) => entry.pending).length >= MAX_INFLIGHT)
      return FAILURE(request.id, {
        code: "rate-limited",
        message: "Too many control operations are pending.",
        retryable: false,
      });
    while (cache.size >= REPLAY_LIMIT) {
      const removable = [...cache].find(([, entry]) => !entry.pending);
      if (!removable) break;
      cache.delete(removable[0]);
    }
    const promise = execute(request, signal);
    const entry = { fingerprint, promise, expires: now() + REPLAY_TTL_MS, pending: true };
    cache.set(request.id, entry);
    void promise.then(() => {
      entry.pending = false;
      entry.expires = now() + REPLAY_TTL_MS;
    });
    return promise;
  };
}

function jsonObjectCopy(value: unknown): JsonObject {
  const copied: JsonValue = json(value);
  if (copied === null || typeof copied !== "object" || Array.isArray(copied))
    fail("internal", "Invalid configuration document.");
  // JSON copy of a validated document section has string keys and JSON values.
  return Object.fromEntries(Object.entries(copied));
}
