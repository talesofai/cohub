import { ChannelsApi } from "./apis/channels.js";
import { BillingApi } from "./apis/billing.js";
import { CronJobsApi } from "./apis/cron-jobs.js";
import { ExploreApi } from "./apis/explore.js";
import { GenerationsApi } from "./apis/generations.js";
import { ModelsApi } from "./apis/models.js";
import { PromptsApi } from "./apis/prompts.js";
import { PublicAssetsApi } from "./apis/public-assets.js";
import { SessionAccessApi } from "./apis/session-access.js";
import { SearchApi } from "./apis/search.js";
import { SpaceClient, SpacesApi, type WebSocketConnectionState } from "./apis/spaces.js";
import { TasksApi } from "./apis/tasks.js";
import { UserApi } from "./apis/user.js";
import { WorksApi } from "./apis/works.js";
import { PublicInviteApi } from "./apis/invitations.js";
import { HttpTransport, type CohubClientOptions } from "./transport.js";
import { createWebsocketClient } from "./websocket.js";
import { VoiceApi } from "./voice-input.js";
import { resolveApiBaseUrl, resolveWebsocketUrl } from "./environment.js";
import { createWorkRuntime, type WorkRuntimeApi } from "./work-runtime.js";
import type { Permission } from "./types.js";

export class CohubClient {
  readonly spaces: SpacesApi;
  readonly channels: ChannelsApi;
  readonly billing: BillingApi;
  readonly user: UserApi;
  readonly generations: GenerationsApi;
  readonly models: ModelsApi;
  readonly prompts: PromptsApi;
  readonly publicAssets: PublicAssetsApi;
  readonly sessionAccess: SessionAccessApi;
  readonly search: SearchApi;
  readonly tasks: TasksApi;
  readonly cronJobs: CronJobsApi;
  readonly explore: ExploreApi;
  readonly invite: PublicInviteApi;
  readonly voice: VoiceApi;
  readonly works: WorksApi;

  private readonly transport: HttpTransport;
  private readonly websocketClient: ReturnType<typeof createWebsocketClient>;
  private readonly workRuntime: WorkRuntimeApi;

  constructor(options: CohubClientOptions = {}) {
    const apiBaseUrl = resolveApiBaseUrl(options);
    this.workRuntime = createWorkRuntime();
    const getAccessToken = options.getAccessToken ?? ((tokenOptions?: { forceRefresh?: boolean }) => this.workRuntime.getAccessToken(tokenOptions));
    const resolvedOptions = { ...options, getAccessToken };
    this.transport = new HttpTransport(resolvedOptions);
    this.websocketClient = createWebsocketClient({
      url: resolveWebsocketUrl({
        env: options.websocket?.env ?? options.env,
        url: options.websocket?.url,
      }),
      ...options.websocket,
      getAccessToken: options.websocket?.getAccessToken ?? getAccessToken,
    });
    this.voice = new VoiceApi({
      ...options.voice,
      env: options.voice?.env ?? options.env,
      url: options.voice?.url,
      getAccessToken: options.voice?.getAccessToken ?? getAccessToken,
    });
    this.spaces = new SpacesApi(this.transport);
    this.channels = new ChannelsApi(this.transport);
    this.billing = new BillingApi(this.transport);
    this.user = new UserApi(
      this.transport,
      apiBaseUrl,
      options.setStoredAuthToken,
      options.clearStoredAuthToken,
    );
    this.generations = new GenerationsApi(this.transport);
    this.models = new ModelsApi(this.transport);
    this.prompts = new PromptsApi(this.transport);
    this.publicAssets = new PublicAssetsApi(this.transport);
    this.sessionAccess = new SessionAccessApi(this.transport);
    this.search = new SearchApi(this.transport);
    this.tasks = new TasksApi(this.transport);
    this.cronJobs = new CronJobsApi(this.transport);
    this.explore = new ExploreApi(this.transport);
    this.invite = new PublicInviteApi(this.transport);
    this.works = new WorksApi(this.transport);
  }

  context() {
    return this.workRuntime.context();
  }

  readonly auth = {
    request: (input: { scopes: Permission[]; reason?: string }) => this.workRuntime.requestAuthorization(input),
  };

  space(spaceId: string) {
    return new SpaceClient(spaceId, this.transport, this.websocketClient);
  }

  onConnection(
    handler: (state: WebSocketConnectionState) => void,
  ): () => void {
    const connectingCleanup = this.websocketClient.on("connecting", (payload) => {
      handler({
        state: payload.isReconnect ? "reconnecting" : "connecting",
        willReconnect: payload.isReconnect,
        attempt: payload.attempt,
      });
    });
    const reconnectingCleanup = this.websocketClient.on("reconnecting", (payload) => {
      handler({
        state: "reconnecting",
        willReconnect: true,
        attempt: payload.attempt,
        delayMs: payload.delayMs,
      });
    });
    const openCleanup = this.websocketClient.on("open", (payload) => {
      handler({
        state: "open",
        willReconnect: false,
        connectionId: payload.connectionId,
      });
    });
    const closeCleanup = this.websocketClient.on("close", (payload) => {
      handler({
        state: "closed",
        willReconnect: payload.willReconnect,
      });
    });
    const errorCleanup = this.websocketClient.on("error", (payload) => {
      handler({
        state: "error",
        willReconnect: payload.recoverable,
        recoverable: payload.recoverable,
      });
    });
    return () => {
      connectingCleanup();
      reconnectingCleanup();
      openCleanup();
      closeCleanup();
      errorCleanup();
    };
  }
}

export const createCohubClient = (options?: CohubClientOptions) =>
  new CohubClient(options);
