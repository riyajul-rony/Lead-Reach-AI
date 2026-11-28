import { db } from "@/server/db";
import { encrypt } from "@/server/crypto";
import { getConfig, invalidateSettingCache } from "@/server/config";
import { recordAuditLog } from "@/server/audit";

export interface ManualPaymentConfig {
  bkashNumber: string;
  nagadNumber: string;
  bankName: string;
  bankAccountName: string;
  bankAccountNumber: string;
  note: string;
  usdToBdtRate: number | null;
  isConfigured: boolean;
}

export interface SaveManualPaymentConfigInput {
  bkashNumber?: string;
  nagadNumber?: string;
  bankName?: string;
  bankAccountName?: string;
  bankAccountNumber?: string;
  note?: string;
  usdToBdtRate?: number | string | null;
}

function cleanStr(val: unknown, maxLen: number): string {
  if (typeof val !== "string") return "";
  return val.trim().slice(0, maxLen);
}

function parseRate(val: unknown): number | null {
  if (val === null || val === undefined || val === "") return null;
  const num = Number(val);
  if (!Number.isFinite(num) || num <= 0 || num > 100_000) return null;
  return Math.round(num * 100) / 100;
}

export function computeBdtAmount(amountUsd: number, usdToBdtRate: number | null): number | null {
  if (!usdToBdtRate || !Number.isFinite(usdToBdtRate) || usdToBdtRate <= 0) return null;
  if (!Number.isFinite(amountUsd) || amountUsd <= 0) return null;
  return Math.round(amountUsd * usdToBdtRate);
}

export function hasConfiguredManualMethod(cfg: {
  bkashNumber: string;
  nagadNumber: string;
  bankName: string;
  bankAccountName: string;
  bankAccountNumber: string;
}): boolean {
  return Boolean(
    cfg.bkashNumber ||
      cfg.nagadNumber ||
      (cfg.bankName && cfg.bankAccountNumber)
  );
}

export function parseManualPaymentConfig(raw: string | undefined | null, fallbackRateRaw?: string | undefined | null): ManualPaymentConfig {
  let parsed: Record<string, unknown> = {};
  if (raw && raw.trim()) {
    try {
      const obj = JSON.parse(raw);
      if (obj && typeof obj === "object") {
        parsed = obj as Record<string, unknown>;
      }
    } catch {
      parsed = {};
    }
  }

  const bkashNumber = cleanStr(parsed.bkashNumber, 40);
  const nagadNumber = cleanStr(parsed.nagadNumber, 40);
  const bankName = cleanStr(parsed.bankName, 120);
  const bankAccountName = cleanStr(parsed.bankAccountName, 120);
  const bankAccountNumber = cleanStr(parsed.bankAccountNumber, 60);
  const note = cleanStr(parsed.note, 500);
  const usdToBdtRate = parseRate(parsed.usdToBdtRate) ?? parseRate(fallbackRateRaw);

  return {
    bkashNumber,
    nagadNumber,
    bankName,
    bankAccountName,
    bankAccountNumber,
    note,
    usdToBdtRate,
    isConfigured: hasConfiguredManualMethod({
      bkashNumber,
      nagadNumber,
      bankName,
      bankAccountName,
      bankAccountNumber,
    }),
  };
}

export async function getManualPaymentConfig(): Promise<ManualPaymentConfig> {
  const [rawConfig, fallbackRate] = await Promise.all([
    getConfig("MANUAL_PAYMENT_CONFIG").catch(() => undefined),
    getConfig("USD_TO_BDT_RATE").catch(() => undefined),
  ]);
  return parseManualPaymentConfig(rawConfig, fallbackRate);
}

export function formatManualInstructionsText(
  config: ManualPaymentConfig,
  amountUsd: number,
  currency: string,
  invoiceNumber: string
): string {
  if (!config.isConfigured) {
    return "";
  }

  const bdtAmount = computeBdtAmount(amountUsd, config.usdToBdtRate);
  const amountLine = bdtAmount
    ? `${currency} ${amountUsd.toFixed(2)} (BDT ${bdtAmount.toLocaleString()} @ ${config.usdToBdtRate} BDT/USD)`
    : `${currency} ${amountUsd.toFixed(2)}`;

  const lines: string[] = [`Amount Due: ${amountLine}`, `Reference / Invoice: #${invoiceNumber}`, ""];
  if (config.bkashNumber) {
    lines.push(`bKash: ${config.bkashNumber}`);
  }
  if (config.nagadNumber) {
    lines.push(`Nagad: ${config.nagadNumber}`);
  }
  if (config.bankName && config.bankAccountNumber) {
    lines.push(
      `Bank Transfer: ${config.bankName}${config.bankAccountName ? ` — Account Name: ${config.bankAccountName}` : ""}, Account #: ${config.bankAccountNumber}`
    );
  }
  if (config.note) {
    lines.push("", `Note: ${config.note}`);
  }
  return lines.join("\n").trim();
}

export async function saveManualPaymentConfig(
  input: SaveManualPaymentConfigInput,
  adminId: string
): Promise<ManualPaymentConfig> {
  const before = await getManualPaymentConfig().catch(() => null);

  const normalized = {
    bkashNumber: cleanStr(input.bkashNumber, 40),
    nagadNumber: cleanStr(input.nagadNumber, 40),
    bankName: cleanStr(input.bankName, 120),
    bankAccountName: cleanStr(input.bankAccountName, 120),
    bankAccountNumber: cleanStr(input.bankAccountNumber, 60),
    note: cleanStr(input.note, 500),
    usdToBdtRate: parseRate(input.usdToBdtRate),
  };

  if (
    input.usdToBdtRate !== null &&
    input.usdToBdtRate !== undefined &&
    input.usdToBdtRate !== "" &&
    normalized.usdToBdtRate === null
  ) {
    throw new Error("USD to BDT rate must be a positive number (up to 100,000).");
  }

  if ((normalized.bankName && !normalized.bankAccountNumber) || (!normalized.bankName && normalized.bankAccountNumber)) {
    throw new Error("Both Bank Name and Bank Account Number are required when configuring bank transfer.");
  }

  const serialized = JSON.stringify(normalized);
  await db.system_settings.upsert({
    where: { key: "MANUAL_PAYMENT_CONFIG" },
    create: {
      key: "MANUAL_PAYMENT_CONFIG",
      value_enc: encrypt(serialized),
    },
    update: {
      value_enc: encrypt(serialized),
    },
  });

  await invalidateSettingCache("MANUAL_PAYMENT_CONFIG");

  await recordAuditLog({
    adminId,
    action: "billing.manual_settings_updated",
    targetType: "system_settings",
    targetId: "MANUAL_PAYMENT_CONFIG",
    beforeState: before
      ? {
          hasBkash: Boolean(before.bkashNumber),
          hasNagad: Boolean(before.nagadNumber),
          hasBank: Boolean(before.bankName && before.bankAccountNumber),
          usdToBdtRate: before.usdToBdtRate,
        }
      : null,
    afterState: {
      hasBkash: Boolean(normalized.bkashNumber),
      hasNagad: Boolean(normalized.nagadNumber),
      hasBank: Boolean(normalized.bankName && normalized.bankAccountNumber),
      usdToBdtRate: normalized.usdToBdtRate,
    },
  });

  return {
    ...normalized,
    isConfigured: hasConfiguredManualMethod(normalized),
  };
}
