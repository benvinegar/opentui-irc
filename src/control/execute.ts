import type {
  ControlError,
  ControlHandler,
  ControlRequest,
  ControlResponse,
} from "../contracts/control";
import type { SecretProvider, SettingsRepository } from "../contracts/settings";
import { createSettingsRepository } from "../storage/settings";
import { createControlService } from "./service";
import { parseControlRequest } from "./protocol";
import { acquireControlLease, createControlClient, probeControlServer } from "./socket";

export interface ControlExecutorOptions {
  readonly configDirectory: string;
  readonly secrets: SecretProvider;
  readonly settingsFactory?: (directory: string) => SettingsRepository;
}

/** Prefer the authoritative running app. Only provably offline profiles permit direct writes. */
export function createControlExecutor(options: ControlExecutorOptions) {
  const offline = new Map<string, ControlHandler>();
  return async (
    request: ControlRequest,
    signal: AbortSignal,
    context: { readonly configDirectory?: string } = {},
  ): Promise<ControlResponse> => {
    const rejected = (error: ControlError): ControlResponse => ({
      version: 1,
      id: request.id,
      ok: false,
      error,
    });
    try {
      const parsed = parseControlRequest(request);
      if (!parsed.ok) return rejected(parsed.error);
      if (Buffer.byteLength(JSON.stringify(request)) > 1048576)
        return rejected({
          code: "invalid-input",
          message: "Control request exceeds the size limit.",
          retryable: false,
        });
      const directory = context.configDirectory ?? options.configDirectory;
      const probe = await probeControlServer(directory, signal);
      if (!probe.ok) return rejected(probe.error);
      if (probe.value === "live") {
        const response = await createControlClient({ configDirectory: directory }).request(
          request,
          signal,
        );
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
        return await service(request, signal);
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
