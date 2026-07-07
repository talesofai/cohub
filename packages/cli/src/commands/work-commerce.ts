import type { SpaceCommerceProduct, WorkCommerceEntitlement, WorkCommerceEntitlementsResponse, WorkCommerceOrder } from "@neta-art/cohub";
import type { Command } from "commander";
import { createClient } from "../client.js";
import { error, handleHttp, json as outJson, jsonRequested, ok, table } from "../output.js";

type JsonOption = { json?: boolean };

type ProductKeysOptions = JsonOption & {
  workId?: string;
  productKey?: string[];
};

type PurchaseOptions = JsonOption & {
  workId?: string;
  productKey?: string;
};

type OrderGetOptions = JsonOption & {
  workId?: string;
  orderId?: string;
};

type ConsumeOptions = JsonOption & {
  workId?: string;
  amount?: string;
  operationId?: string;
  reason?: string;
};

function collectOption(value: string, previous: string[] = []): string[] {
  return [...previous, value];
}

function requireText(value: string | undefined, label: string, flag: string): string {
  const text = value?.trim();
  if (text) return text;
  return error(`Missing ${label}`, `Pass ${flag}.`);
}

function requireList(values: string[] | undefined, label: string, flag: string): string[] {
  const items = [...new Set((values ?? []).map((value) => value.trim()).filter(Boolean))];
  if (items.length > 0) return items;
  return error(`Missing ${label}`, `Pass ${flag}.`);
}

function formatUsd(amount: number): string {
  return `$${amount.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function formatMinorUsd(amountMinor: number): string {
  return formatUsd(amountMinor / 100);
}

function printProducts(products: SpaceCommerceProduct[]): void {
  table(products.map((product) => ({
    key: product.key,
    name: product.name,
    status: product.status,
    visibility: product.visibility,
    price: formatUsd(product.pricing.amountUsd),
    credits: product.display.creditsAmount ?? "",
  })), [
    { key: "key", label: "Key" },
    { key: "name", label: "Name" },
    { key: "status", label: "Status" },
    { key: "visibility", label: "Visibility" },
    { key: "price", label: "Price" },
    { key: "credits", label: "Credits" },
  ]);
}

function printEntitlements(result: WorkCommerceEntitlementsResponse): void {
  table(result.entitlements.map((item: WorkCommerceEntitlement) => ({
    benefitKey: item.benefitKey,
    enabled: item.enabled ? "yes" : "no",
    metadata: item.metadata ? JSON.stringify(item.metadata) : "",
  })), [
    { key: "benefitKey", label: "Benefit" },
    { key: "enabled", label: "Enabled" },
    { key: "metadata", label: "Metadata" },
  ]);
  console.log(`\nCredits available: ${result.credits.available} (net: ${result.credits.net})`);
}

function printOrder(order: WorkCommerceOrder): void {
  table([{
    id: order.id,
    product: order.productKeySnapshot,
    status: order.status,
    amount: formatMinorUsd(order.amountSnapshot),
    paid: formatMinorUsd(order.paidAmountSnapshot),
    created: order.createdAt,
    paidAt: order.paidAt ?? "",
  }], [
    { key: "id", label: "ID" },
    { key: "product", label: "Product" },
    { key: "status", label: "Status" },
    { key: "amount", label: "Amount" },
    { key: "paid", label: "Paid" },
    { key: "created", label: "Created" },
    { key: "paidAt", label: "Paid At" },
  ]);
}

export function registerWorkCommerce(worksCmd: Command): void {
  const commerceCmd = worksCmd
    .command("commerce")
    .description("Work commerce operations")
    .addHelpText("after", `
Examples:
  cohub works commerce products resolve --work-id <work-id> --product-key pro_pack
  cohub works commerce entitlements --work-id <work-id>
  cohub works commerce credits consume --work-id <work-id> --amount 100
`);

  const productsCmd = commerceCmd
    .command("products")
    .description("Resolve commerce products");

  productsCmd
    .command("resolve")
    .description("Resolve public products for a work")
    .option("--work-id <id>", "Work ID")
    .option("--product-key <key>", "Product key", collectOption)
    .option("--json", "Output as JSON")
    .action(async (opts: ProductKeysOptions) => {
      const workId = requireText(opts.workId, "work ID", "--work-id <id>");
      const productKeys = requireList(opts.productKey, "product key", "--product-key <key>");
      const client = createClient();
      try {
        const result = await client.workCommerce.resolveProducts(workId, { productKeys });
        if (jsonRequested(opts)) return outJson(result);
        printProducts(result.products);
      } catch (e: unknown) {
        handleHttp(e);
      }
    });

  commerceCmd
    .command("entitlements")
    .description("Show viewer entitlements and credit balance for a work")
    .option("--work-id <id>", "Work ID")
    .option("--json", "Output as JSON")
    .action(async (opts: JsonOption & { workId?: string }) => {
      const workId = requireText(opts.workId, "work ID", "--work-id <id>");
      const client = createClient();
      try {
        const result = await client.workCommerce.getEntitlements(workId);
        if (jsonRequested(opts)) return outJson(result);
        printEntitlements(result);
      } catch (e: unknown) {
        handleHttp(e);
      }
    });

  const creditsCmd = commerceCmd
    .command("credits")
    .description("Consume credits for a work");

  creditsCmd
    .command("consume")
    .description("Consume credits for a work (self by default)")
    .option("--work-id <id>", "Work ID")
    .option("--amount <n>", "Positive integer credit amount")
    .option("--operation-id <id>", "Idempotency key (generated when omitted)")
    .option("--reason <text>", "Reason for the consumption")
    .option("--json", "Output as JSON")
    .action(async (opts: ConsumeOptions) => {
      const workId = requireText(opts.workId, "work ID", "--work-id <id>");
      const amountText = requireText(opts.amount, "amount", "--amount <n>");
      const amount = Number.parseInt(amountText, 10);
      if (!Number.isSafeInteger(amount) || amount <= 0) {
        return error("Invalid amount", "--amount must be a positive integer.");
      }
      const operationId = opts.operationId?.trim() || crypto.randomUUID();
      const client = createClient();
      try {
        const result = await client.workCommerce.consumeCredits(workId, {
          amount,
          operationId,
          reason: opts.reason,
        });
        if (jsonRequested(opts)) return outJson({ ...result, operationId });
        ok(`Consumed ${result.amount} credits (operation: ${operationId})`);
        table([{
          status: result.status,
          amount: result.amount,
          remaining: result.remaining,
          shortfall: result.shortfall ?? "",
        }], [
          { key: "status", label: "Status" },
          { key: "amount", label: "Amount" },
          { key: "remaining", label: "Remaining" },
          { key: "shortfall", label: "Shortfall" },
        ]);
      } catch (e: unknown) {
        handleHttp(e);
      }
    });

  commerceCmd
    .command("purchase")
    .description("Create a work purchase checkout")
    .option("--work-id <id>", "Work ID")
    .option("--product-key <key>", "Product key")
    .option("--json", "Output as JSON")
    .action(async (opts: PurchaseOptions) => {
      const workId = requireText(opts.workId, "work ID", "--work-id <id>");
      const productKey = requireText(opts.productKey, "product key", "--product-key <key>");
      const client = createClient();
      try {
        const result = await client.workCommerce.purchase(workId, {
          productKey,
          checkoutMode: "hosted_page",
        });
        if (jsonRequested(opts)) return outJson(result);
        ok(`Checkout created: ${result.checkout.orderId}`);
        table([{
          orderId: result.checkout.orderId,
          productKey: result.checkout.productKey,
          usable: result.checkout.checkoutUsable ? "yes" : "no",
          status: result.checkout.status ?? "",
          checkoutUiMode: result.checkout.checkoutUiMode ?? "",
          checkoutUrl: result.checkout.checkoutUrl ?? "",
          checkoutClientSecret: result.checkout.checkoutClientSecret ?? "",
          message: result.checkout.message ?? "",
        }], [
          { key: "orderId", label: "Order" },
          { key: "productKey", label: "Product" },
          { key: "usable", label: "Usable" },
          { key: "status", label: "Status" },
          { key: "checkoutUiMode", label: "Mode" },
          { key: "checkoutUrl", label: "Checkout URL" },
          { key: "checkoutClientSecret", label: "Client Secret" },
          { key: "message", label: "Message" },
        ]);
      } catch (e: unknown) {
        handleHttp(e);
      }
    });

  const ordersCmd = commerceCmd
    .command("orders")
    .description("Look up commerce orders");

  ordersCmd
    .command("get")
    .description("Show a work commerce order")
    .option("--work-id <id>", "Work ID")
    .option("--order-id <id>", "Order ID")
    .option("--json", "Output as JSON")
    .action(async (opts: OrderGetOptions) => {
      const workId = requireText(opts.workId, "work ID", "--work-id <id>");
      const orderId = requireText(opts.orderId, "order ID", "--order-id <id>");
      const client = createClient();
      try {
        const result = await client.workCommerce.getOrder(workId, orderId);
        if (jsonRequested(opts)) return outJson(result);
        printOrder(result.order);
      } catch (e: unknown) {
        handleHttp(e);
      }
    });
}
