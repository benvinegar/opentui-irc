import type {
  ControlError,
  ControlHandler,
  ControlMethod,
  ControlRequest,
  ControlResponse,
} from "../contracts/control";
import { CONTROL_METHODS } from "../contracts/control";
import type { SecretProvider, SettingsRepository } from "../contracts/settings";
import { createSettingsRepository } from "../storage/settings";
import { createControlService } from "./service";
import { isJsonObject, parseControlRequest } from "./protocol";
import {
  acquireControlLease,
  createControlClient,
  DEFAULT_CONTROL_LIMITS,
  probeControlServer,
} from "./socket";

export interface ControlExecutorOptions {
  readonly configDirectory: string;
  readonly secrets: SecretProvider;
  /** RPC deadline only; an admitted offline save is always awaited while holding its lease. */
  readonly timeoutMs?: number;
  readonly settingsFactory?: (directory: string) => SettingsRepository;
}

const OFFLINE_METHODS: readonly ControlMethod[] = [
  "capabilities",
  "status",
  "config.schema",
  "config.get",
  "config.plan",
  "config.apply",
  "config.reload",
  "networks.list",
  "secrets.store",
];

/** Offline responses advertise offline-only reach; plans never claim live runtime effects. */
function offlineResponse(method: ControlMethod, response: ControlResponse): ControlResponse {
  if (!response.ok || !isJsonObject(response.result)) return response;
  if (method === "capabilities")
    return {
      ...response,
      result: {
        ...response.result,
        methods: [...OFFLINE_METHODS],
        liveOnlyMethods: CONTROL_METHODS.filter(
          (candidate) => !OFFLINE_METHODS.includes(candidate),
        ),
      },
    };
  if (method === "config.plan" || method === "config.apply")
    // Plans describe live policy effects. Offline saves persist configuration
    // only; they do not update a renderer, connect, prune history or clear drafts.
    return {
      ...response,
      result: {
        ...response.result,
        mode: "offline",
        runtimeEffectsApplied: false,
      },
    };
  return response;
}

/** Prefer the authoritative running app. Only provably offline profiles permit direct writes. */
export function createControlExecutor(options: ControlExecutorOptions) {
  const offline = new Map<string, ControlHandler>();
  const offlineService = (cacheKey: string, directory: string): ControlHandler => {
    const cached = offline.get(cacheKey);
    if (cached) return cached;
    const service = createControlService({
      settings: (options.settingsFactory ?? createSettingsRepository)(directory),
      secrets: options.secrets,
      permissions: ["inspect", "configure", "network", "destructive"],
    });
    offline.set(cacheKey, service);
    // A CLI process normally uses one profile. Bound long-lived embedded use too.
    if (offline.size > 16) {
      const oldest = offline.keys().next().value;
      if (oldest) offline.delete(oldest);
    }
    return service;
  };
  return async (
    request: ControlRequest,
    signal: AbortSignal,
    context: { readonly configDirectory?: string } = {},
  ): Promise<ControlResponse> => {
    let responseId = "invalid";
    const rejected = (error: ControlError): ControlResponse => ({
      version: 1,
      id: responseId,
      ok: false,
      error,
    });
    try {
      const parsed = parseControlRequest(request);
      if (!parsed.ok) return rejected(parsed.error);
      responseId = parsed.value.id;
      if (
        Buffer.byteLength(JSON.stringify(parsed.value)) + 1 >
        DEFAULT_CONTROL_LIMITS.maxRequestBytes
      )
        return rejected({
          code: "invalid-input",
          message: "Control request exceeds the size limit.",
          retryable: false,
        });
      const directory = context.configDirectory ?? options.configDirectory;
      const probe = await probeControlServer(directory, signal);
      if (!probe.ok) return rejected(probe.error);
      if (probe.value === "live") {
        const response = await createControlClient({
          configDirectory: directory,
          ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
        }).request(parsed.value, signal);
        return response.ok ? response.value : rejected(response.error);
      }
      if (probe.value === "busy")
        return rejected({
          code: "unavailable",
          message:
            "This profile is busy, initializing, or has control disabled. No offline changes were made.",
          retryable: false,
        });
      const acquired = await acquireControlLease(directory, signal);
      if (!acquired.ok) return rejected(acquired.error);
      try {
        if (signal.aborted)
          return rejected({
            code: "cancelled",
            message: "Control request cancelled.",
            retryable: false,
          });
        if (!OFFLINE_METHODS.includes(parsed.value.method))
          return rejected({
            code: "unavailable",
            message:
              "This command needs a running opentui-irc instance. No offline changes were made.",
            retryable: false,
          });
        const service = offlineService(acquired.value.paths.directory, directory);
        return offlineResponse(parsed.value.method, await service(parsed.value, signal));
      } finally {
        await acquired.value.release();
      }
    } catch {
      return rejected({
        code: "internal",
        message: "Unable to execute the local control request safely.",
        retryable: false,
      });
    }
  };
}
