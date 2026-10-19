import type { AppApi } from "./app";
import type { Clock, Diagnostics, IdGenerator, Result } from "./common";
import type { NotificationSink } from "./services";
import type { SessionFactory } from "./session";
import type { SecretProvider, SettingsRepository } from "./settings";
import type { HistoryRepository } from "./storage";

export interface AppDependencies {
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly diagnostics: Diagnostics;
  readonly sessions: SessionFactory;
  readonly settings: SettingsRepository;
  readonly secrets: SecretProvider;
  readonly history: HistoryRepository;
  readonly notifications: NotificationSink;
}

/** Async boot loads configuration/migrations/read positions before enabling auto-connect. */
export type CreateApp = (
  dependencies: AppDependencies,
  signal: AbortSignal,
) => Promise<Result<AppApi>>;
