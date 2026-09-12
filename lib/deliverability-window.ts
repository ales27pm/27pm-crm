const DELIVERABILITY_WINDOWS = ["24h", "7d", "30d"] as const;

export type DeliverabilityWindow = (typeof DELIVERABILITY_WINDOWS)[number];

export function parseDeliverabilityWindow(
  value: string | null,
): DeliverabilityWindow | null {
  const candidate = value ?? "30d";
  return DELIVERABILITY_WINDOWS.find((windowName) => windowName === candidate) ?? null;
}
