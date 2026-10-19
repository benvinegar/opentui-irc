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

/** Prefer the authoritative running app. Only provably offline profiles permit direct writes. */
export function createControlExecutor(options: ControlExecutorOptions) {
  const offline = new Map<string, ControlHandler>();
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
            message: "This command needs a running OpenIRC instance. No offline changes were made.",
            retryable: false,
          });
        const cacheKey = acquired.value.paths.directory;
        let service = offline.get(cacheKey);
        if (!service) {
          service = createControlService({
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
        }
        const response = await service(parsed.value, signal);
        if (
          parsed.value.method === "capabilities" &&
          response.ok &&
          isJsonObject(response.result)
        ) {
          return {
            ...response,
            result: {
              ...response.result,
              methods: [...OFFLINE_METHODS],
              liveOnlyMethods: CONTROL_METHODS.filter(
                (method) => !OFFLINE_METHODS.includes(method),
              ),
            },
          };
        }
        if (
          (parsed.value.method === "config.plan" || parsed.value.method === "config.apply") &&
          response.ok &&
          isJsonObject(response.result)
        ) {
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
        }
        return response;
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
