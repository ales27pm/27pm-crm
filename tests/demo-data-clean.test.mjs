import assert from "node:assert/strict";
import test from "node:test";

import { demoDashboard } from "../app/demo-data.ts";

test("demo mode contains only the approved initial account cohort", () => {
  assert.deepEqual(
    demoDashboard.mailboxes.map(({ address, label, kind }) => ({
      address,
      label,
      kind,
    })),
    [
      {
        address: "bonjour@27pm.org",
        label: "Prospects et clients",
        kind: "sales",
      },
      {
        address: "alexis@27pm.org",
        label: "Alexis Boulet",
        kind: "sales",
      },
      {
        address: "admin@27pm.org",
        label: "Comptes et opérations",
        kind: "operations",
      },
    ],
  );
  assert.deepEqual(
    demoDashboard.organizations.map((organization) => organization.name),
    [
      "S.Huot",
      "JAMEC",
      "Vallée",
      "Machineries Pronovost",
      "Groupe Industriel Interprovincial",
    ],
  );
  assert.equal(
    demoDashboard.mailboxes.reduce(
      (total, mailbox) => total + mailbox.unreadCount,
      0,
    ),
    0,
  );
  for (const collection of [
    demoDashboard.conversations,
    demoDashboard.contacts,
    demoDashboard.deals,
    demoDashboard.tasks,
    demoDashboard.strategies,
    demoDashboard.intakes,
    demoDashboard.activities,
  ]) {
    assert.deepEqual(collection, []);
  }

  const serialized = JSON.stringify(demoDashboard);
  for (const forbidden of [
    ".example",
    "Atelier Nord",
    "Gagnon & associés",
    "Roy Construction",
  ]) {
    assert.equal(serialized.includes(forbidden), false);
  }
});
