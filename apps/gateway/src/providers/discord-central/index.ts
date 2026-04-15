import type {
  DiscordCentralChannelCredentials,
  GatewayOutboundCommand,
} from "@cohub/protocol";
import { gatewayConfig } from "../../config.js";
import type { GatewayProvider } from "../base.js";

const buildHeaders = () => {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };

  if (gatewayConfig.discordCentralSecret) {
    headers["x-discord-central-secret"] = gatewayConfig.discordCentralSecret;
  }

  return headers;
};

const requestDiscordCentral = async <T>(input: {
  path: string;
  method: "POST" | "DELETE";
  body?: unknown;
}): Promise<T> => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), gatewayConfig.discordCentralTimeoutMs);

  let response: Response;
  try {
    response = await fetch(`${gatewayConfig.discordCentralBaseUrl}${input.path}`, {
      method: input.method,
      headers: buildHeaders(),
      body: input.body === undefined ? undefined : JSON.stringify(input.body),
      signal: controller.signal,
    });
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error(
        `discord-central ${input.method} ${input.path} timed out after ${gatewayConfig.discordCentralTimeoutMs}ms`,
      );
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    const text = await response.text().catch(() => response.statusText);
    throw new Error(
      `discord-central ${input.method} ${input.path} failed: ${response.status} ${text}`,
    );
  }

  if (response.status === 204) {
    return null as T;
  }

  return (await response.json()) as T;
};

export class DiscordCentralProvider implements GatewayProvider {
  private readonly channelId: string;
  private readonly credentials: DiscordCentralChannelCredentials;
  private registrationPromise?: Promise<void>;
  private registered = false;
  private destroyed = false;

  constructor(channelId: string, credentials: DiscordCentralChannelCredentials) {
    this.channelId = channelId;
    this.credentials = credentials;
    void this.ensureRegistered().catch((error) => {
      console.warn(
        `[DiscordCentral:${this.channelId}] Initial registration failed:`,
        error instanceof Error ? error.message : String(error),
      );
    });
  }

  private async register() {
    await requestDiscordCentral<{ ok: true }>({
      path: "/internal/channels/upsert",
      method: "POST",
      body: {
        channelId: this.channelId,
        credentials: this.credentials,
      },
    });

    this.registered = true;
    console.log(`[DiscordCentral:${this.channelId}] Channel registered`);
  }

  private async ensureRegistered() {
    if (this.destroyed) {
      throw new Error("discord-central provider is destroyed");
    }
    if (this.registered) {
      return;
    }
    if (this.registrationPromise) {
      await this.registrationPromise;
      return;
    }

    const registrationPromise = this.register()
      .catch((error) => {
        this.registered = false;
        throw error;
      })
      .finally(() => {
        if (this.registrationPromise === registrationPromise) {
          this.registrationPromise = undefined;
        }
      });

    this.registrationPromise = registrationPromise;
    await registrationPromise;
  }

  public async handleOutbound(cmd: GatewayOutboundCommand) {
    try {
      await this.ensureRegistered();
      const result = await requestDiscordCentral<{
        success: boolean;
        error?: string;
        externalMessageId?: string;
      }>({
        path: "/internal/messages",
        method: "POST",
        body: { command: cmd },
      });
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[DiscordCentral:${this.channelId}] Outbound failed:`, message);
      return { success: false as const, error: message };
    }
  }

  public async destroy() {
    this.destroyed = true;

    const unregister = async () => {
      if (!this.registered) {
        return false;
      }

      await requestDiscordCentral<{ ok: true }>({
        path: `/internal/channels/${this.channelId}`,
        method: "DELETE",
      });
      this.registered = false;
      return true;
    };

    const pendingRegistration = this.registrationPromise ?? Promise.resolve();

    try {
      await pendingRegistration.catch(() => undefined);
      const didUnregister = await unregister();
      if (didUnregister) {
        console.log(`[DiscordCentral:${this.channelId}] Channel unregistered`);
      }
    } catch (error) {
      console.error(
        `[DiscordCentral:${this.channelId}] Unregister failed:`,
        error instanceof Error ? error.message : String(error),
      );
    }
  }
}
