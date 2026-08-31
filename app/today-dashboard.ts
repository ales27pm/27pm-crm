import type {
  Conversation,
  CrmTask,
  DashboardData,
  Deal,
  IntakeSubmission,
  Organization,
} from "./crm-types";

export type TodayFollowUp =
  | {
      kind: "deal";
      id: string;
      title: string;
      organization: string;
      dueAt: string;
      dealId: string;
    }
  | {
      kind: "organization";
      id: string;
      title: string;
      organization: string;
      dueAt: string;
      organizationId: string;
    };

export type TodayDashboard = {
  pendingIntakes: IntakeSubmission[];
  overdueTasks: CrmTask[];
  unreadConversations: Conversation[];
  dueFollowUps: TodayFollowUp[];
  atRiskDeals: Deal[];
  upcomingDeals: Deal[];
  accountsToPlan: Organization[];
  actionCount: number;
  riskCount: number;
};

const activeSalesStages = new Set<Deal["stage"]>([
  "nouveau",
  "qualifie",
  "proposition",
]);

export function buildTodayDashboard(
  data: DashboardData,
  now = new Date(),
): TodayDashboard {
  const today = dateKey(now);
  const blockedOrganizationIds = new Set(
    data.organizations.filter((account) => account.doNotContact).map((account) => account.id),
  );
  const organizationNames = countOrganizationNames(data.organizations);
  const blockedOrganizationNames = new Set(
    data.organizations
      .filter(
        (account) =>
          account.doNotContact && organizationNames.get(normalize(account.name)) === 1,
      )
      .map((account) => normalize(account.name)),
  );
  const eligibleDeals = data.deals.filter(
    (deal) =>
      activeSalesStages.has(deal.stage) &&
      !belongsToBlockedOrganization(
        deal,
        blockedOrganizationIds,
        blockedOrganizationNames,
      ),
  );

  const pendingIntakes = data.intakes
    .toSorted(
      (left, right) =>
        left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id),
    );
  const overdueTasks = data.tasks
    .filter(
      (task) =>
        !task.completed &&
        (task.overdue || Boolean(task.dueAt && isTimestampBefore(task.dueAt, now))),
    )
    .toSorted(
      (left, right) =>
        compareNullableDates(left.dueAt, right.dueAt) || left.id.localeCompare(right.id),
    );
  const unreadConversations = data.conversations
    .filter((conversation) => conversation.unread)
    .toSorted(
      (left, right) =>
        latestMessageAt(left).localeCompare(latestMessageAt(right)) ||
        left.id.localeCompare(right.id),
    );

  const taskDealDates = new Set(
    overdueTasks.flatMap((task) => {
      const dueDate = task.dueAt ? parseDateKey(task.dueAt) : null;
      return task.dealId && dueDate ? [`${task.dealId}:${dueDate}`] : [];
    }),
  );
  const dealsById = new Map(data.deals.map((deal) => [deal.id, deal]));
  const coveredOrganizationDates = new Set<string>();
  for (const task of overdueTasks) {
    const dueDate = task.dueAt ? parseDateKey(task.dueAt) : null;
    const organizationId =
      task.organizationId || (task.dealId ? dealsById.get(task.dealId)?.organizationId : "");
    if (organizationId && dueDate) {
      coveredOrganizationDates.add(`${organizationId}:${dueDate}`);
    }
  }

  const dueDeals = eligibleDeals
    .filter((deal) => {
      const dueDate = parseDateKey(deal.nextActionDate);
      return (
        Boolean(deal.nextAction.trim()) &&
        Boolean(dueDate && dueDate <= today) &&
        !taskDealDates.has(`${deal.id}:${dueDate}`)
      );
    });
  for (const deal of dueDeals) {
    const dueDate = parseDateKey(deal.nextActionDate);
    if (deal.organizationId && dueDate) {
      coveredOrganizationDates.add(`${deal.organizationId}:${dueDate}`);
    }
  }
  const dueDealFollowUps: TodayFollowUp[] = dueDeals
    .map((deal) => ({
      kind: "deal",
      id: deal.id,
      title: deal.nextAction,
      organization: deal.organization,
      dueAt: deal.nextActionDate,
      dealId: deal.id,
    }));
  const dueOrganizationFollowUps: Array<
    Extract<TodayFollowUp, { kind: "organization" }>
  > = data.organizations
    .filter((account) => {
      const dueDate = parseDateKey(account.nextFollowUpAt ?? "");
      return (
        !account.doNotContact &&
        Boolean(dueDate && dueDate <= today) &&
        !coveredOrganizationDates.has(`${account.id}:${dueDate}`)
      );
    })
    .map((account) => ({
      kind: "organization",
      id: account.id,
      title: account.nextStep?.trim() || "Définir la prochaine étape",
      organization: account.name,
      dueAt: account.nextFollowUpAt ?? "",
      organizationId: account.id,
    }));
  const dueFollowUps = [...dueDealFollowUps, ...dueOrganizationFollowUps]
    .toSorted(
      (left, right) =>
        (parseDateKey(left.dueAt) ?? "9999-12-31").localeCompare(
          parseDateKey(right.dueAt) ?? "9999-12-31",
        ) || left.id.localeCompare(right.id),
    );

  const atRiskDeals = eligibleDeals
    .filter((deal) => {
      const nextActionDate = parseDateKey(deal.nextActionDate);
      return !deal.nextAction.trim() || !nextActionDate || nextActionDate < today;
    })
    .toSorted((left, right) => compareDealsByUrgency(left, right, today));
  const upcomingDeals = eligibleDeals
    .filter((deal) => {
      const nextActionDate = parseDateKey(deal.nextActionDate);
      return Boolean(nextActionDate && nextActionDate > today);
    })
    .toSorted(
      (left, right) =>
        (parseDateKey(left.nextActionDate) ?? "").localeCompare(
          parseDateKey(right.nextActionDate) ?? "",
        ) || left.id.localeCompare(right.id),
    );
  const dueOrganizationIds = new Set(
    dueOrganizationFollowUps.map((followUp) => followUp.organizationId),
  );
  const accountsToPlan = data.organizations
    .filter((account) => {
      const followUpDate = parseDateKey(account.nextFollowUpAt ?? "");
      const coveredByTaskOrDeal = Boolean(
        followUpDate && coveredOrganizationDates.has(`${account.id}:${followUpDate}`),
      );
      return (
        !account.doNotContact &&
        !dueOrganizationIds.has(account.id) &&
        !coveredByTaskOrDeal &&
        (!account.nextStep?.trim() || !followUpDate)
      );
    })
    .toSorted(compareAccountsToPlan);

  return {
    pendingIntakes,
    overdueTasks,
    unreadConversations,
    dueFollowUps,
    atRiskDeals,
    upcomingDeals,
    accountsToPlan,
    actionCount:
      pendingIntakes.length +
      overdueTasks.length +
      unreadConversations.length +
      dueFollowUps.length +
      accountsToPlan.length,
    riskCount: overdueTasks.length + atRiskDeals.length,
  };
}

function compareDealsByUrgency(left: Deal, right: Deal, today: string) {
  const leftDate = parseDateKey(left.nextActionDate) ?? "9999-12-31";
  const rightDate = parseDateKey(right.nextActionDate) ?? "9999-12-31";
  const leftOverdue = leftDate < today;
  const rightOverdue = rightDate < today;
  if (leftOverdue !== rightOverdue) return leftOverdue ? -1 : 1;
  return leftDate.localeCompare(rightDate) || left.id.localeCompare(right.id);
}

function compareAccountsToPlan(left: Organization, right: Organization) {
  const priorities: Record<Organization["priority"], number> = {
    very_high: 0,
    high: 1,
    normal: 2,
    low: 3,
  };
  return (
    priorities[left.priority] - priorities[right.priority] ||
    (right.score ?? -1) - (left.score ?? -1) ||
    left.id.localeCompare(right.id)
  );
}

function compareNullableDates(left: string | null, right: string | null) {
  return (left ?? "9999-12-31").localeCompare(right ?? "9999-12-31");
}

function latestMessageAt(conversation: Conversation) {
  return conversation.messages.reduce(
    (latest, message) => message.sentAtIso > latest ? message.sentAtIso : latest,
    "",
  );
}

function belongsToBlockedOrganization(
  deal: Deal,
  blockedOrganizationIds: Set<string>,
  blockedOrganizationNames: Set<string>,
) {
  if (deal.organizationId) return blockedOrganizationIds.has(deal.organizationId);
  return blockedOrganizationNames.has(normalize(deal.organization));
}

function countOrganizationNames(organizations: Organization[]) {
  const counts = new Map<string, number>();
  for (const account of organizations) {
    const name = normalize(account.name);
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return counts;
}

function normalize(value: string) {
  return value.trim().toLocaleLowerCase("fr-CA");
}

function dateKey(value: Date) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Montreal",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(value);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((item) => item.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}

function parseDateKey(value: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2})/u.exec(value);
  if (!match) return null;
  const candidate = `${match[1]}-${match[2]}-${match[3]}`;
  const date = new Date(`${candidate}T12:00:00.000Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== candidate) {
    return null;
  }
  return candidate;
}

function isTimestampBefore(value: string, now: Date) {
  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) && timestamp < now.getTime();
}
