export interface GatewayProvider {
  destroy(): void | Promise<void>;
  handleOutbound(cmd: {
    commandId: string;
    provider: string;
    channelId: string;
    externalChatId: string;
  }): Promise<{ success: boolean; error?: string; externalMessageId?: string }>;
}
