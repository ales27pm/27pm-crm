import assert from "node:assert/strict";
import test from "node:test";

import {
  cakemailAudiencePolicyViolation,
  isGenericRoleMailboxAddress,
} from "../lib/cakemail-audience-policy.ts";

const contact = {
  lawfulBasis: "explicit_consent",
  addressNormalized: "alexis@example.com",
};

const permissionTransport = {
  provider: "cakemail",
  config: { audiencePolicy: { mode: "permission_relationship" } },
};

const exceptionTransport = {
  provider: "cakemail",
  config: {
    audiencePolicy: {
      mode: "written_exception",
      approvalReference: "legal/cakemail/approval-2026-09-12",
      approvalSha256: "b".repeat(64),
    },
  },
};

test("permission/relationship mode admits only direct permission or relationship bases", () => {
  for (const lawfulBasis of [
    "explicit_consent",
    "existing_business_relationship",
    "requested_response",
  ]) {
    assert.equal(
      cakemailAudiencePolicyViolation(permissionTransport, {
        ...contact,
        lawfulBasis,
      }),
      null,
      lawfulBasis,
    );
  }

  for (const lawfulBasis of [
    "conspicuous_publication",
    "direct_disclosure",
    "b2b_exemption",
    "none",
    "unexpected",
  ]) {
    assert.equal(
      cakemailAudiencePolicyViolation(permissionTransport, {
        ...contact,
        lawfulBasis,
      }),
      "cakemail_audience_lawful_basis_not_permitted",
      lawfulBasis,
    );
  }
});

test("permission/relationship mode blocks generic role mailboxes", () => {
  for (const addressNormalized of [
    "info@example.com",
    "support+website@example.com",
    "service-client@example.ca",
    "FACTURATION@example.ca",
  ]) {
    assert.equal(isGenericRoleMailboxAddress(addressNormalized), true);
    assert.equal(
      cakemailAudiencePolicyViolation(permissionTransport, {
        ...contact,
        addressNormalized,
      }),
      "cakemail_audience_role_mailbox_not_permitted",
    );
  }

  for (const addressNormalized of [
    "alexis@example.com",
    "info.alexis@example.com",
    "supporter@example.com",
  ]) {
    assert.equal(isGenericRoleMailboxAddress(addressNormalized), false);
  }
});

test("written exception defers to the CRM compliance decision for any recipient", () => {
  assert.equal(
    cakemailAudiencePolicyViolation(exceptionTransport, {
      lawfulBasis: "conspicuous_publication",
      addressNormalized: "info@example.com",
    }),
    null,
  );
});

test("Mailgun behavior is unchanged by the Cakemail-only policy", () => {
  assert.equal(
    cakemailAudiencePolicyViolation(
      { provider: "mailgun", config: {} },
      { lawfulBasis: "none", addressNormalized: "info@example.com" },
    ),
    null,
  );
});
