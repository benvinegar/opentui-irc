import { randomUUID } from "node:crypto";
import { entityId, type Result } from "../contracts/common";
import type { SecretProvider } from "../contracts/settings";
import { failure, success } from "./errors";
import { secretReference } from "./validation";

const SERVICE = "org.openirc.credentials";
function lookup(operation: Promise<string | null>, signal: AbortSignal): Promise<Result<string>> {
  return new Promise((resolve) => {
    const finish = (result: Result<string>) => {
      signal.removeEventListener("abort", cancel);
      resolve(result);
    };
    const cancel = () => finish(failure("cancelled", "Secret lookup cancelled."));
    signal.addEventListener("abort", cancel, { once: true });
    operation.then(
      (value) =>
        finish(
          value
            ? success(value)
            : failure(
                "unavailable",
                "The credential is not available in the operating-system store.",
              ),
        ),
      () =>
        finish(
          failure("unavailable", "The operating-system credential store could not be accessed."),
        ),
    );
    if (signal.aborted) cancel();
  });
}
/** Environment references are resolved on demand; interactive storage uses only the OS vault. */
export function createSecretProvider(): SecretProvider {
  return {
    async resolve(reference, signal) {
      if (signal.aborted) return failure("cancelled", "Secret lookup cancelled.");
      if (!secretReference(reference))
        return failure("invalid-input", "Invalid credential reference.");
      if (reference.startsWith("env:")) {
        const value = process.env[reference.slice(4)];
        return value
          ? success(value)
          : failure("unavailable", "The referenced environment credential is unavailable.");
      }
      if (typeof Bun === "undefined" || !Bun.secrets || typeof Bun.secrets.get !== "function")
        return failure("unsupported", "An operating-system credential store is not available.");
      try {
        return await lookup(
          Bun.secrets.get({ service: SERVICE, name: reference.slice(9) }),
          signal,
        );
      } catch {
        return failure(
          "unavailable",
          "The operating-system credential store could not be accessed.",
        );
      }
    },
    async store(value, signal) {
      if (signal.aborted) return failure("cancelled", "Secret storage cancelled.");
      if (
        typeof value !== "string" ||
        value.length === 0 ||
        value.length > 65536 ||
        value.includes("\0")
      )
        return failure(
          "invalid-input",
          "Credential must be nonempty and within the supported size.",
        );
      if (
        typeof Bun === "undefined" ||
        !Bun.secrets ||
        typeof Bun.secrets.set !== "function" ||
        typeof Bun.secrets.get !== "function"
      )
        return failure(
          "unsupported",
          "Secure credential storage is unavailable; use an environment reference.",
        );
      const name = randomUUID();
      try {
        await Bun.secrets.set({ service: SERVICE, name, value });
        if ((await Bun.secrets.get({ service: SERVICE, name })) !== value) {
          try {
            await Bun.secrets.delete({ service: SERVICE, name });
          } catch {
            /* No plaintext fallback. */
          }
          return failure(
            "unsupported",
            "Secure credential storage could not be verified; use an environment reference.",
          );
        }
        return success(entityId<"secret-ref">(`keychain:${name}`));
      } catch {
        try {
          await Bun.secrets.delete({ service: SERVICE, name });
        } catch {
          /* Best effort cleanup of a possibly admitted vault write. */
        }
        return failure(
          "unsupported",
          "Secure credential storage is unavailable; use an environment reference.",
        );
      }
    },
  };
}
