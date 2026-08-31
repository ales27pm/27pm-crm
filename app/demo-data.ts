import type { DashboardData } from "./crm-types";

export const emptyDashboard: DashboardData = {
  mailboxes: [
    {
      address: "bonjour@27pm.org",
      label: "Prospects et clients",
      kind: "sales",
      unreadCount: 0,
    },
    {
      address: "admin@27pm.org",
      label: "Comptes et opérations",
      kind: "operations",
      unreadCount: 0,
    },
  ],
  transportState: "configuration",
  live: false,
  conversations: [],
  organizations: [],
  contacts: [],
  deals: [],
  tasks: [],
  strategies: [],
  intakes: [],
  activities: [],
};

function demoAccount(
  id: string,
  name: string,
  score: number,
  priority: "very_high" | "high",
  budgetMinCents: number,
  budgetMaxCents: number,
) {
  return {
    id,
    name,
    website: null,
    sourceLabel: "Document utilisateur — cohorte initiale",
    sourceUrl: null,
    sourceDate: null,
    score,
    priority,
    budgetMinCents,
    budgetMaxCents,
    budgetIsHypothesis: true,
    ownerEmail: null,
    doNotContact: false,
    lastContactAt: null,
    nextFollowUpAt: null,
    nextStep: "Valider le compte et identifier un rôle professionnel pertinent",
    notes:
      "Hypothèse de prospection à valider; enveloppe indicative non confirmée.",
    contactCount: 0,
  };
}

export const demoDashboard: DashboardData = {
  ...emptyDashboard,
  organizations: [
    demoAccount(
      "org-cohort-s-huot",
      "S.Huot",
      96,
      "very_high",
      2_000_000,
      3_500_000,
    ),
    demoAccount(
      "org-cohort-jamec",
      "JAMEC",
      94,
      "very_high",
      2_500_000,
      4_000_000,
    ),
    demoAccount(
      "org-cohort-vallee",
      "Vallée",
      92,
      "high",
      2_500_000,
      4_000_000,
    ),
    demoAccount(
      "org-cohort-pronovost",
      "Machineries Pronovost",
      89,
      "high",
      3_000_000,
      5_000_000,
    ),
    demoAccount(
      "org-cohort-gii",
      "Groupe Industriel Interprovincial",
      83,
      "high",
      1_200_000,
      2_200_000,
    ),
  ],
};
