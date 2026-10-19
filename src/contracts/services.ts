import type { AppAction } from "./app";
import type { ConversationId, NetworkId, Result } from "./common";

export interface InputContext {
  readonly networkId?: NetworkId;
  readonly conversationId?: ConversationId;
}

/** Slash commands and palette items resolve to the same typed actions as mouse controls. */
export type InputIntent =
  | { readonly type: "action"; readonly action: AppAction }
  | { readonly type: "help"; readonly command?: string }
  | { readonly type: "settings" }
  | { readonly type: "quit" };

export interface Completion {
  readonly label: string;
  readonly insertText: string;
  /** UTF-16 string offsets, NOT terminal display cells. End is exclusive. */
  readonly replace: { readonly start: number; readonly end: number };
}

export interface CommandService {
  /** Called only on deliberate submit. Paste never invokes this method automatically. */
  parse(text: string, context: InputContext): Result<InputIntent>;
  complete(text: string, cursorUtf16: number, context: InputContext): readonly Completion[];
  help(
    command?: string,
  ): readonly { readonly name: string; readonly usage: string; readonly description: string }[];
}

export interface NotificationSink {
  /** App has already checked mute, focus, playback, privacy and rate limits. */
  notify(notification: {
    readonly title: string;
    readonly body?: string;
    readonly conversationId: ConversationId;
  }): Promise<Result<void>>;
}

/** UI obtains explicit user consent before calling; adapter validates schemes again. */
export interface ExternalActions {
  openUrl(url: string, signal: AbortSignal): Promise<Result<void>>;
  copyText(text: string, signal: AbortSignal): Promise<Result<void>>;
}
