import type { GatewayAuthUser } from "./config.js";
import { gatewayConfig } from "./config.js";

const parseJson = async <T>(response: Response): Promise<T | null> => {
  return response.json().catch(() => null) as Promise<T | null>;
};

export type SessionAuthorizationResult =
  | {
      ok: true;
      user: GatewayAuthUser & { uuid: string };
      spaceId: string;
      sessionId: string;
    }
  | {
      ok: false;
      status: 401 | 404;
      error: {
        message: string;
        type: "authentication_error" | "invalid_request_error";
      };
    };

export const authorizeSessionAccess = async (input: {
  token: string;
  spaceId: string;
  sessionId: string;
}): Promise<SessionAuthorizationResult> => {
  const sessionResponse = await fetch(`${gatewayConfig.apiBaseUrl}/api/sessions/${input.sessionId}`, {
    headers: {
      authorization: `Bearer ${input.token}`,
    },
  });

  if (sessionResponse.status === 401 || sessionResponse.status === 403) {
    return {
      ok: false,
      status: 401,
      error: {
        message: "Unauthorized",
        type: "authentication_error",
      },
    };
  }

  if (sessionResponse.status === 404) {
    return {
      ok: false,
      status: 404,
      error: {
        message: "Session not found",
        type: "invalid_request_error",
      },
    };
  }

  if (!sessionResponse.ok) {
    const text = await sessionResponse.text().catch(() => "");
    throw new Error(`Session authorization failed ${sessionResponse.status}: ${text}`);
  }

  const data = await parseJson<{
    space?: { id?: string };
    session?: { id?: string };
    user?: GatewayAuthUser;
  }>(sessionResponse);

  if (!data?.space?.id || !data?.session?.id) {
    return {
      ok: false,
      status: 404,
      error: {
        message: "Session not found",
        type: "invalid_request_error",
      },
    };
  }

  if (data.space.id !== input.spaceId || data.session.id !== input.sessionId) {
    return {
      ok: false,
      status: 404,
      error: {
        message: "Session does not belong to space",
        type: "invalid_request_error",
      },
    };
  }

  const user = data.user;
  if (!user?.uuid) {
    return {
      ok: false,
      status: 401,
      error: {
        message: "Unauthorized",
        type: "authentication_error",
      },
    };
  }

  return {
    ok: true,
    user: user as GatewayAuthUser & { uuid: string },
    spaceId: data.space.id,
    sessionId: data.session.id,
  };
};
