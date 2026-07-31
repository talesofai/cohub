import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { db } from "../db/index.js";
import { userChannels, spaceChannels, spaces } from "@cohub/db";
import { eq, and, desc, inArray } from "drizzle-orm";
import { useAuth, requireValidId, type AuthUser } from "../lib/middleware.js";
import { redisCommandClient } from "../redis.js";
import { deleteChannelResponse, type DeleteChannelResult } from "./channel-delete.js";
import { fallbackBoundChannelHealth, getChannelHealthMap } from "../channel-health.js";
import { getIdentityKeys, identityEquals } from "../identity-bridge.js";

const WECHAT_LOGIN_BASE_URL = "https://ilinkai.weixin.qq.com";
const WECHAT_CDN_BASE_URL = "https://novac2c.cdn.weixin.qq.com/c2c";
const WECHAT_BOT_TYPE = "3";
const WECHAT_ILINK_APP_ID = "bot";
const WECHAT_ILINK_APP_CLIENT_VERSION = "132099";
const WECHAT_LOGIN_TTL_SECONDS = 10 * 60;
const WECHAT_QR_START_TIMEOUT_MS = 15_000;
const WECHAT_QR_STATUS_TIMEOUT_MS = 25_000;
const WECHAT_CONFIRM_LOCK_TTL_SECONDS = 60;

const router = new Hono();

const serializeChannel = <T extends { credentials?: unknown }>(channel: T) => {
  const { credentials: _credentials, ...safeChannel } = channel;
  return safeChannel;
};

const wechatLoginKey = (sessionKey: string) => `channels:wechat_login:${sessionKey}`;
const wechatConfirmLockKey = (sessionKey: string) => `channels:wechat_login_confirm:${sessionKey}`;

const isAllowedWeChatBaseUrl = (value: string) => {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && (url.hostname === "ilinkai.weixin.qq.com" || url.hostname.endsWith(".weixin.qq.com"));
  } catch {
    return false;
  }
};

const resolveWeChatBaseUrl = (value: string | undefined) => {
  const trimmed = value?.trim();
  return trimmed && isAllowedWeChatBaseUrl(trimmed) ? trimmed : WECHAT_LOGIN_BASE_URL;
};

async function fetchTextWithTimeout(url: URL, init: RequestInit, timeoutMs: number) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    const text = await response.text();
    return { response, text };
  } finally {
    clearTimeout(timeout);
  }
}

type WeChatLoginState = {
  userUuid: string;
  name: string;
  qrcode: string;
  qrDataUrl: string;
  startedAt: number;
  currentBaseUrl?: string;
};

type WeChatChannelCredentials = {
  token?: string;
  accountId?: string;
  userId?: string;
  baseUrl?: string;
  cdnBaseUrl?: string;
};

type WeChatQrResponse = {
  qrcode?: string;
  qrcode_img_content?: string;
};

type WeChatQrStatusResponse = {
  status?: "wait" | "scaned" | "confirmed" | "expired" | "scaned_but_redirect" | "need_verifycode" | "verify_code_blocked" | "binded_redirect" | string;
  bot_token?: string;
  ilink_bot_id?: string;
  ilink_user_id?: string;
  baseurl?: string;
  redirect_host?: string;
};

async function listUserWeChatChannels(user: AuthUser) {
  return db
    .select()
    .from(userChannels)
    .where(and(inArray(userChannels.userUuid, getIdentityKeys(user)), eq(userChannels.provider, "wechat")))
    .orderBy(desc(userChannels.updatedAt), desc(userChannels.createdAt));
}

function getWeChatCredentials(channel: { credentials: unknown }) {
  return (channel.credentials && typeof channel.credentials === "object" ? channel.credentials : {}) as WeChatChannelCredentials;
}

function findWeChatChannelByAccountId<T extends { credentials: unknown }>(channels: T[], accountId: string | undefined) {
  const normalized = accountId?.trim();
  if (!normalized) return null;
  return channels.find((channel) => getWeChatCredentials(channel).accountId?.trim() === normalized) ?? null;
}

async function fetchWeChatQrCode(localTokenList: string[]) {
  const url = new URL(`ilink/bot/get_bot_qrcode?bot_type=${encodeURIComponent(WECHAT_BOT_TYPE)}`, `${WECHAT_LOGIN_BASE_URL}/`);
  const { response, text } = await fetchTextWithTimeout(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "iLink-App-Id": WECHAT_ILINK_APP_ID,
      "iLink-App-ClientVersion": WECHAT_ILINK_APP_CLIENT_VERSION,
    },
    body: JSON.stringify({ local_token_list: localTokenList.slice(0, 10) }),
  }, WECHAT_QR_START_TIMEOUT_MS);
  if (!response.ok) throw new Error(`WeChat QR start failed ${response.status}: ${text.slice(0, 200)}`);
  try {
    const parsed = JSON.parse(text) as WeChatQrResponse;
    if (!parsed.qrcode || !parsed.qrcode_img_content) throw new Error("WeChat QR response is incomplete");
    return { qrcode: parsed.qrcode, qrDataUrl: parsed.qrcode_img_content };
  } catch (error) {
    throw new Error(error instanceof Error ? error.message : "WeChat QR response is invalid");
  }
}

async function pollWeChatQrStatus(qrcode: string, baseUrl = WECHAT_LOGIN_BASE_URL, verifyCode?: string) {
  const url = new URL(`ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`, `${resolveWeChatBaseUrl(baseUrl)}/`);
  if (verifyCode?.trim()) url.searchParams.set("verify_code", verifyCode.trim());
  try {
    const { response, text } = await fetchTextWithTimeout(url, {
      method: "GET",
      headers: {
        "iLink-App-Id": WECHAT_ILINK_APP_ID,
        "iLink-App-ClientVersion": WECHAT_ILINK_APP_CLIENT_VERSION,
      },
    }, WECHAT_QR_STATUS_TIMEOUT_MS);
    if (!response.ok) throw new Error(`WeChat QR status failed ${response.status}: ${text.slice(0, 200)}`);
    return JSON.parse(text) as WeChatQrStatusResponse;
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") return { status: "wait" } satisfies WeChatQrStatusResponse;
    throw error;
  }
}

router.post("/wechat/login/start", async (c) => {
  const user = useAuth(c);
  if (user instanceof Response) return user;
  const body = (await c.req.json<{ name?: string }>().catch(() => ({}))) as { name?: string };
  const name = body.name?.trim() || "WeChat";

  let qr: { qrcode: string; qrDataUrl: string };
  try {
    const channels = await listUserWeChatChannels(user);
    const localTokenList = channels
      .map((channel) => getWeChatCredentials(channel).token?.trim())
      .filter((token): token is string => Boolean(token))
      .slice(0, 10);
    qr = await fetchWeChatQrCode(localTokenList);
  } catch (error) {
    return c.json({ message: error instanceof Error ? error.message : "Failed to start WeChat login." }, 502);
  }
  const sessionKey = randomUUID();
  const state: WeChatLoginState = {
    userUuid: user.uuid,
    name,
    qrcode: qr.qrcode,
    qrDataUrl: qr.qrDataUrl,
    startedAt: Date.now(),
  };
  await redisCommandClient.set(wechatLoginKey(sessionKey), JSON.stringify(state), "EX", WECHAT_LOGIN_TTL_SECONDS);

  return c.json({
    sessionKey,
    qrDataUrl: qr.qrDataUrl,
    message: "Scan the QR code with WeChat to connect this channel.",
    expiresInSeconds: WECHAT_LOGIN_TTL_SECONDS,
  });
});

router.post("/wechat/login/wait", async (c) => {
  const user = useAuth(c);
  if (user instanceof Response) return user;
  const body = (await c.req.json<{ sessionKey?: string; verifyCode?: string }>().catch(() => ({}))) as { sessionKey?: string; verifyCode?: string };
  const sessionKey = body.sessionKey?.trim();
  if (!sessionKey) return c.json({ message: "sessionKey is required" }, 400);

  const rawState = await redisCommandClient.get(wechatLoginKey(sessionKey));
  if (!rawState) return c.json({ connected: false, expired: true, message: "Login session expired. Start again." });

  const state = JSON.parse(rawState) as WeChatLoginState;
  if (!identityEquals(user, state.userUuid)) return c.json({ message: "login session not found" }, 404);

  const status = await pollWeChatQrStatus(state.qrcode, state.currentBaseUrl, body.verifyCode);
  if (status.status === "scaned_but_redirect" && status.redirect_host) {
    const nextState = { ...state, currentBaseUrl: resolveWeChatBaseUrl(`https://${status.redirect_host}`) };
    await redisCommandClient.set(wechatLoginKey(sessionKey), JSON.stringify(nextState), "EX", WECHAT_LOGIN_TTL_SECONDS);
    return c.json({ connected: false, status: status.status, message: "Redirected. Waiting for confirmation." });
  }

  if (status.status === "wait" || status.status === "scaned") {
    return c.json({ connected: false, status: status.status, message: status.status === "scaned" ? "Confirm on your phone." : "Waiting for scan." });
  }

  if (status.status === "need_verifycode") {
    return c.json({ connected: false, status: status.status, needVerifyCode: true, message: "Enter the code shown in WeChat." });
  }

  if (status.status === "verify_code_blocked") {
    await redisCommandClient.del(wechatLoginKey(sessionKey));
    return c.json({ connected: false, status: status.status, expired: true, message: "Too many incorrect codes. Start again later." });
  }

  if (status.status === "expired") {
    await redisCommandClient.del(wechatLoginKey(sessionKey));
    return c.json({ connected: false, expired: true, message: "QR code expired. Start again." });
  }

  if (status.status === "binded_redirect") {
    const channels = await listUserWeChatChannels(user);
    await redisCommandClient.del(wechatLoginKey(sessionKey));
    const onlyChannel = channels.length === 1 ? channels[0] : null;
    if (onlyChannel) {
      return c.json({ connected: true, alreadyConnected: true, status: status.status, message: "WeChat is already connected.", channel: serializeChannel(onlyChannel) });
    }
    return c.json({ connected: false, alreadyConnected: true, status: status.status, message: "This WeChat bot is already connected." });
  }

  if (status.status !== "confirmed") {
    return c.json({ connected: false, status: status.status ?? "unknown", message: "Waiting for confirmation." });
  }

  if (!status.bot_token || !status.ilink_bot_id) {
    await redisCommandClient.del(wechatLoginKey(sessionKey));
    return c.json({ connected: false, message: "WeChat login did not return credentials." }, 502);
  }

  const lockAcquired = await redisCommandClient.set(wechatConfirmLockKey(sessionKey), "1", "EX", WECHAT_CONFIRM_LOCK_TTL_SECONDS, "NX");
  if (lockAcquired !== "OK") {
    return c.json({ connected: false, status: "confirming", message: "Finalizing WeChat connection." });
  }

  try {
    const credentials: WeChatChannelCredentials = {
      token: status.bot_token,
      accountId: status.ilink_bot_id,
      userId: status.ilink_user_id,
      baseUrl: resolveWeChatBaseUrl(status.baseurl),
      cdnBaseUrl: WECHAT_CDN_BASE_URL,
    };
    const existingChannel = findWeChatChannelByAccountId(await listUserWeChatChannels(user), status.ilink_bot_id);
    if (existingChannel) {
      const [channel] = await db.update(userChannels)
        .set({ userUuid: user.uuid, credentials, status: "active", updatedAt: new Date() })
        .where(and(eq(userChannels.id, existingChannel.id), inArray(userChannels.userUuid, getIdentityKeys(user))))
        .returning();
      await redisCommandClient.del(wechatLoginKey(sessionKey));
      return c.json({ connected: true, alreadyConnected: true, message: "WeChat is already connected.", channel: channel ? serializeChannel(channel) : null });
    }

    const [channel] = await db.insert(userChannels).values({
      userUuid: user.uuid,
      provider: "wechat",
      name: state.name,
      credentials,
      status: "active",
    }).returning();

    await redisCommandClient.del(wechatLoginKey(sessionKey));
    return c.json({ connected: true, message: "WeChat connected.", channel: channel ? serializeChannel(channel) : null }, 201);
  } finally {
    await redisCommandClient.del(wechatConfirmLockKey(sessionKey)).catch(() => undefined);
  }
});
router.get("/", async (c) => {
  const user = useAuth(c);
  if (user instanceof Response) return user;

  const channels = await db
    .select()
    .from(userChannels)
    .where(inArray(userChannels.userUuid, getIdentityKeys(user)))
    .orderBy(desc(userChannels.updatedAt), desc(userChannels.createdAt));

  const channelIds = channels.map((ch) => ch.id);
  const boundRows = channelIds.length > 0
    ? await db
        .select({
          spaceChannelId: spaceChannels.id,
          channelId: spaceChannels.channelId,
          spaceId: spaceChannels.spaceId,
          name: spaces.name,
        })
        .from(spaceChannels)
        .leftJoin(spaces, eq(spaces.id, spaceChannels.spaceId))
        .where(inArray(spaceChannels.channelId, channelIds))
    : [];

  const boundByChannelId = new Map(boundRows.map((row) => [row.channelId, row]));
  const healthBySpaceChannelId = await getChannelHealthMap(boundRows.map((row) => row.spaceChannelId));

  return c.json(
    channels.map((channel) => {
      const bound = boundByChannelId.get(channel.id);
      const health = bound
        ? (healthBySpaceChannelId.get(bound.spaceChannelId) ?? fallbackBoundChannelHealth())
        : null;
      return {
        ...serializeChannel(channel),
        boundSpace: bound ? { id: bound.spaceId, title: bound.name ?? null, status: "active" } : null,
        health,
      };
    }),
  );
});

router.post("/", async (c) => {
  const user = useAuth(c);
  if (user instanceof Response) return user;

  const body = (await c.req
    .json<{ provider?: string; name?: string; credentials?: Record<string, unknown> }>()
    .catch(() => ({}))) as {
    provider?: string;
    name?: string;
    credentials?: Record<string, unknown>;
  };
  const provider = body.provider?.trim();
  const name = body.name?.trim();
  if (!provider || !name || !body.credentials || typeof body.credentials !== "object") {
    return c.json({ message: "provider, name and credentials are required" }, 400);
  }
  if (provider === "wechat") {
    return c.json({ message: "Create WeChat channels through the QR login flow." }, 400);
  }

  const [channel] = await db
    .insert(userChannels)
    .values({
      userUuid: user.uuid,
      provider,
      name,
      credentials: body.credentials,
      status: "active",
    })
    .returning();

  return c.json(channel ? serializeChannel(channel) : null, 201);
});

router.delete("/:id", async (c) => {
  const user = useAuth(c);
  if (user instanceof Response) return user;
  const channelId = c.req.param("id");
  if (!requireValidId(channelId)) return c.json({ message: "channel not found" }, 404);

  // Use a transaction with FOR UPDATE to prevent TOCTOU race:
  // without it, a concurrent space channel binding could leave orphaned spaceChannels rows.
  const result = await db.transaction<DeleteChannelResult>(async (tx) => {
    const [channel] = await tx
      .select()
      .from(userChannels)
      .where(and(eq(userChannels.id, channelId), inArray(userChannels.userUuid, getIdentityKeys(user))))
      .limit(1)
      .for("update");
    if (!channel) return "not_found";

    const bound = await tx
      .select({ id: spaceChannels.id })
      .from(spaceChannels)
      .where(eq(spaceChannels.channelId, channelId))
      .limit(1);
    if (bound.length > 0) return "bound";

    await tx.delete(userChannels).where(eq(userChannels.id, channelId));
    return "deleted";
  });
  const response = deleteChannelResponse(result);

  return c.json(response.body, response.status);
});

export default router;
