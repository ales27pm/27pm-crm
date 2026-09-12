import { zonedDateTimeValue, zonedLocalDateTimeIso } from "./zoned-date-time";

export type OutreachActionType =
  | "research"
  | "review"
  | "email"
  | "call"
  | "nurture";

export type OutreachStepStatus =
  | "planned"
  | "ready"
  | "blocked"
  | "done"
  | "skipped";

export type OutreachCadenceStep = {
  businessDayOffset: number;
  actionType: OutreachActionType;
  title: string;
  purpose: string;
  requiresContact: boolean;
};

export const OUTREACH_CADENCE: readonly OutreachCadenceStep[] = [
  {
    businessDayOffset: -2,
    actionType: "research",
    title: "Finaliser l’audit du compte",
    purpose: "Confirmer les constats publics et préparer une valeur concrète à montrer.",
    requiresContact: false,
  },
  {
    businessDayOffset: -1,
    actionType: "review",
    title: "Vérifier le décideur et la conformité",
    purpose: "Confirmer le rôle, la provenance, la pertinence et le fondement avant tout contact.",
    requiresContact: false,
  },
  {
    businessDayOffset: 0,
    actionType: "email",
    title: "Premier courriel personnalisé",
    purpose: "Présenter un seul angle précis et demander la permission d’envoyer l’audit ou la maquette.",
    requiresContact: true,
  },
  {
    businessDayOffset: 5,
    actionType: "email",
    title: "Première relance utile",
    purpose: "Ajouter un constat ou un aperçu nouveau, sans répéter le premier message.",
    requiresContact: true,
  },
  {
    businessDayOffset: 12,
    actionType: "email",
    title: "Dernière relance",
    purpose: "Poser une dernière question simple et annoncer clairement la fin de la séquence.",
    requiresContact: true,
  },
  {
    businessDayOffset: 13,
    actionType: "nurture",
    title: "Clore ou mettre en veille",
    purpose: "Fermer la séquence sans réponse ou planifier une nouvelle vérification sur signal concret.",
    requiresContact: false,
  },
] as const;

export type BuiltOutreachStep = OutreachCadenceStep & {
  id: string;
  sequenceIndex: number;
  scheduledAt: string;
  status: OutreachStepStatus;
};

export function buildOutreachSteps({
  strategyId,
  startAt,
  contactReady,
  recipientTimezone,
}: {
  strategyId: string;
  startAt: string;
  contactReady: boolean;
  recipientTimezone: string;
}): BuiltOutreachStep[] {
  const start = new Date(startAt);
  if (Number.isNaN(start.valueOf())) throw new TypeError("strategy_start_invalid");

  return OUTREACH_CADENCE.map((step, sequenceIndex) => ({
    ...step,
    id: `${strategyId}-step-${String(sequenceIndex).padStart(2, "0")}`,
    sequenceIndex,
    scheduledAt: addBusinessDays(start, step.businessDayOffset, recipientTimezone).toISOString(),
    status: step.requiresContact && !contactReady ? "blocked" : "planned",
  }));
}

export function addBusinessDays(source: Date, offset: number, timeZone = "UTC"): Date {
  if (!Number.isInteger(offset)) throw new TypeError("business_day_offset_invalid");
  const local = zonedDateTimeValue(source.toISOString(), timeZone);
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/u.exec(local);
  if (!match) throw new TypeError("strategy_timezone_invalid");
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  const direction = offset < 0 ? -1 : 1;
  let remaining = Math.abs(offset);
  while (remaining > 0) {
    date.setUTCDate(date.getUTCDate() + direction);
    const day = date.getUTCDay();
    if (day !== 0 && day !== 6) remaining -= 1;
  }
  const localTarget = `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}T${match[4]}:${match[5]}`;
  const resolved = zonedLocalDateTimeIso(localTarget, timeZone);
  if (!resolved) throw new TypeError("strategy_timezone_invalid");
  return new Date(resolved);
}

export type OutreachStepTiming = "overdue" | "today" | "upcoming" | "invalid";

export function outreachStepTiming(
  scheduledAt: string,
  recipientTimezone: string,
  now = new Date(),
): OutreachStepTiming {
  const scheduled = new Date(scheduledAt);
  if (Number.isNaN(scheduled.valueOf()) || Number.isNaN(now.valueOf())) return "invalid";
  if (scheduled.valueOf() < now.valueOf()) return "overdue";
  try {
    const format = new Intl.DateTimeFormat("en-CA", {
      timeZone: recipientTimezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
    return format.format(scheduled) === format.format(now) ? "today" : "upcoming";
  } catch {
    return "invalid";
  }
}
