import type { HttpTransport } from "../transport.js";
import type { SpaceCommerceProduct } from "../types.js";

export type WorkCommerceEntitlement = {
  benefitKey: string;
  enabled: boolean;
  metadata: Record<string, string | number | boolean>;
};

export type WorkCommerceEntitlementsResponse = {
  entitlements: WorkCommerceEntitlement[];
  credits: {
    available: number;
    net: number;
  };
  businessKey: string;
};

export type WorkCommerceCheckoutStatus = "success" | "failed" | "cancel" | null;

export type WorkCommerceProductResolveResponse = {
  products: SpaceCommerceProduct[];
};

export type WorkCommerceCreditConsumeStatus = "consumed" | "insufficient" | "disabled";

export type WorkCommerceCreditConsumeResponse = {
  status: WorkCommerceCreditConsumeStatus;
  amount: number;
  remaining: number;
  shortfall: number | null;
  businessKey: string;
};

export type WorkCommercePurchaseResponse = {
  checkout: {
    providerKey: string | null;
    checkoutUrl: string | null;
    checkoutClientSecret: string | null;
    checkoutUiMode: string | null;
    checkoutUsable: boolean;
    status: string | null;
    message: string | null;
    orderId: string;
    productKey: string;
  };
};

export type WorkCommerceCheckoutMode = "hosted_page" | "embedded_page";

export type WorkCommerceOrder = {
  id: string;
  productKeySnapshot: string;
  productNameSnapshot: string;
  status: string;
  amountSnapshot: number;
  paidAmountSnapshot: number;
  createdAt: string;
  paidAt: string | null;
  buyerProfile: import("../types.js").SpaceCommerceBuyerProfile | null;
};

export class WorkCommerceApi {
  constructor(private readonly transport: HttpTransport) {}

  resolveProducts(workId: string, input: { productKeys: string[] }) {
    return this.transport.request<WorkCommerceProductResolveResponse>(
      `/api/works/${encodeURIComponent(workId)}/commerce/products/resolve`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      },
    );
  }

  getEntitlements(workId: string) {
    return this.transport.request<WorkCommerceEntitlementsResponse>(
      `/api/works/${encodeURIComponent(workId)}/commerce/entitlements`,
    );
  }

  consumeCredits(workId: string, input: { amount: number; operationId: string; reason?: string }) {
    return this.transport.request<WorkCommerceCreditConsumeResponse>(
      `/api/works/${encodeURIComponent(workId)}/commerce/credits/consume`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      },
    );
  }

  purchase(workId: string, input: { productKey: string; checkoutMode?: WorkCommerceCheckoutMode }) {
    return this.transport.request<WorkCommercePurchaseResponse>(
      `/api/works/${encodeURIComponent(workId)}/commerce/purchase`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      },
    );
  }

  getOrder(workId: string, orderId: string) {
    return this.transport.request<{ order: WorkCommerceOrder }>(
      `/api/works/${encodeURIComponent(workId)}/commerce/orders/${encodeURIComponent(orderId)}`,
    );
  }
}
