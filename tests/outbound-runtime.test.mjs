import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

register(
  `data:text/javascript,${encodeURIComponent(`
    export async function resolve(specifier, context, nextResolve) {
      if (specifier === "server-only") {
        return { shortCircuit: true, url: "data:text/javascript,export {};" };
      }
      if (specifier === "cloudflare:workers") {
        return {
          shortCircuit: true,
          url: "data:text/javascript,export const env = new Proxy({}, { get: (_, key) => process.env[key] });",
        };
      }
      return nextResolve(specifier, context);
    }
  `)}`,
  import.meta.url,
);

const {
  outboundTransportConfig,
  outboundTransportOperational,
  requireOutboundOperationalConfig,
  selectedOutboundProvider,
} = await import("../lib/outbound-runtime.ts");
const { cakemailConfig } = await import("../lib/cakemail-runtime.ts");

const VALID_WEBHOOK_SECRETS = JSON.stringify({
  "Email.Sent": ["sent-secret"],
  "Email.Delivered": ["delivered-secret"],
  "Email.Rejected": ["rejected-secret"],
  "Email.Error": ["error-secret"],
  "Email.Bounced": ["bounced-secret"],
  "Email.ReportedAsSpam": ["complaint-secret"],
  "Email.Unsubscribed": ["unsubscribe-secret"],
  "Email.GlobalUnsubscribed": ["global-unsubscribe-secret"],
});

function activationBinding({
  accountId = 17,
  listId = 23,
  contentMode = "html",
  senderIds = {
    "bonjour@27pm.org": "sender-bonjour",
    "alexis@27pm.org": "sender-alexis",
  },
  audiencePolicy = { mode: "permission_relationship" },
} = {}) {
  return JSON.stringify({
    version: 2,
    accountId,
    listId,
    contentMode,
    senderIds,
    audiencePolicy,
  });
}

const MANAGED_ENV = [
  "CRM_OUTBOUND_PROVIDER",
  "MAILGUN_API_BASE",
  "MAILGUN_DOMAIN",
  "MAILGUN_SENDING_KEY",
  "MAILGUN_WEBHOOK_SIGNING_KEY",
  "CAKEMAIL_API_BASE",
  "CAKEMAIL_PAT",
  "CAKEMAIL_ACCOUNT_ID",
  "CAKEMAIL_LIST_ID",
  "CAKEMAIL_CONTENT_MODE",
  "CAKEMAIL_SENDER_ID_BONJOUR",
  "CAKEMAIL_SENDER_ID_ALEXIS",
  "CAKEMAIL_SENDER_ID_ADMIN",
  "CAKEMAIL_AUDIENCE_MODE",
  "CAKEMAIL_ACTIVATION_BINDING_JSON",
  "CAKEMAIL_WEBHOOK_SECRETS_JSON",
  "CAKEMAIL_LIST_POLICY_ACCEPTED",
  "CAKEMAIL_TRACKING_DOMAIN_READY",
  "CAKEMAIL_PROSPECTING_APPROVED",
  "CAKEMAIL_PROSPECTING_APPROVAL_REFERENCE",
  "CAKEMAIL_PROSPECTING_APPROVAL_SHA256",
  "CAKEMAIL_HEADER_PRESERVATION_CONFIRMED",
  "CAKEMAIL_DKIM_ALIGNMENT_CONFIRMED",
];

const VALID_CAKEMAIL_ENV = {
  CRM_OUTBOUND_PROVIDER: "cakemail",
  MAILGUN_WEBHOOK_SIGNING_KEY: "inbound-signing-key",
  CAKEMAIL_PAT: `ck_pat_${"a".repeat(40)}`,
  CAKEMAIL_ACCOUNT_ID: "17",
  CAKEMAIL_LIST_ID: "23",
  CAKEMAIL_CONTENT_MODE: "html",
  CAKEMAIL_SENDER_ID_BONJOUR: "sender-bonjour",
  CAKEMAIL_SENDER_ID_ALEXIS: "sender-alexis",
  CAKEMAIL_AUDIENCE_MODE: "permission_relationship",
  CAKEMAIL_ACTIVATION_BINDING_JSON: activationBinding(),
  CAKEMAIL_WEBHOOK_SECRETS_JSON: VALID_WEBHOOK_SECRETS,
  CAKEMAIL_LIST_POLICY_ACCEPTED: "true",
  CAKEMAIL_TRACKING_DOMAIN_READY: "true",
  CAKEMAIL_PROSPECTING_APPROVED: "false",
  CAKEMAIL_HEADER_PRESERVATION_CONFIRMED: "true",
  CAKEMAIL_DKIM_ALIGNMENT_CONFIRMED: "true",
};

async function withEnvironment(values, callback) {
  const previous = Object.fromEntries(
    MANAGED_ENV.map((name) => [name, process.env[name]]),
  );
  for (const name of MANAGED_ENV) delete process.env[name];
  Object.assign(process.env, values);

  try {
    return await callback();
  } finally {
    for (const name of MANAGED_ENV) {
      const value = previous[name];
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

test("defaults to the existing Mailgun outbound transport", async () => {
  await withEnvironment(
    {
      MAILGUN_DOMAIN: "27pm.org",
      MAILGUN_SENDING_KEY: "mailgun-test-key",
      MAILGUN_WEBHOOK_SIGNING_KEY: "mailgun-webhook-key",
    },
    () => {
      assert.equal(selectedOutboundProvider(), "mailgun");
      assert.deepEqual(outboundTransportConfig(), {
        provider: "mailgun",
        config: {
          apiBase: "https://api.mailgun.net",
          domain: "27pm.org",
          sendingKey: "mailgun-test-key",
        },
      });
      assert.equal(outboundTransportOperational(), true);
    },
  );
});

test("fails closed for an unknown outbound provider", async () => {
  await withEnvironment(
    {
      CRM_OUTBOUND_PROVIDER: "other-provider",
      MAILGUN_WEBHOOK_SIGNING_KEY: "mailgun-webhook-key",
    },
    () => {
      assert.throws(selectedOutboundProvider, /CRM_OUTBOUND_PROVIDER is invalid/u);
      assert.throws(outboundTransportConfig, /CRM_OUTBOUND_PROVIDER is invalid/u);
      assert.equal(outboundTransportOperational(), false);
    },
  );
});

test("builds a pinned, gated Cakemail configuration", async () => {
  await withEnvironment(
    {
      ...VALID_CAKEMAIL_ENV,
      CAKEMAIL_API_BASE: "https://attacker.example",
    },
    () => {
      assert.equal(selectedOutboundProvider(), "cakemail");
      assert.deepEqual(outboundTransportConfig(), {
        provider: "cakemail",
        config: {
          apiBase: "https://api.cakemail.dev",
          pat: VALID_CAKEMAIL_ENV.CAKEMAIL_PAT,
          accountId: 17,
          listId: 23,
          contentMode: "html",
          senderIds: {
            "bonjour@27pm.org": "sender-bonjour",
            "alexis@27pm.org": "sender-alexis",
          },
          audiencePolicy: { mode: "permission_relationship" },
        },
      });
      assert.equal(outboundTransportOperational(), true);
    },
  );
});

test("accepts text mode and an optional opaque admin sender ID", async () => {
  await withEnvironment(
    {
      ...VALID_CAKEMAIL_ENV,
      CAKEMAIL_CONTENT_MODE: "text",
      CAKEMAIL_SENDER_ID_ADMIN: "admin:27pm/primary",
      CAKEMAIL_ACTIVATION_BINDING_JSON: activationBinding({
        contentMode: "text",
        senderIds: {
          "bonjour@27pm.org": "sender-bonjour",
          "alexis@27pm.org": "sender-alexis",
          "admin@27pm.org": "admin:27pm/primary",
        },
      }),
    },
    () => {
      const config = cakemailConfig();
      assert.equal(config.contentMode, "text");
      assert.equal(
        config.senderIds["admin@27pm.org"],
        "admin:27pm/primary",
      );
    },
  );
});

test("requires a distinct Cakemail identity for every sender address", async () => {
  const duplicatedSenderIds = {
    "bonjour@27pm.org": "sender-bonjour",
    "alexis@27pm.org": "sender-bonjour",
  };
  await withEnvironment(
    {
      ...VALID_CAKEMAIL_ENV,
      CAKEMAIL_SENDER_ID_ALEXIS: "sender-bonjour",
      CAKEMAIL_ACTIVATION_BINDING_JSON: activationBinding({
        senderIds: duplicatedSenderIds,
      }),
    },
    () => {
      assert.throws(
        cakemailConfig,
        /Cakemail sender IDs must be unique/u,
      );
      assert.equal(outboundTransportOperational(), false);
    },
  );
});

test("builds a written-exception audience policy only from bound evidence", async () => {
  const audiencePolicy = {
    mode: "written_exception",
    approvalReference: "legal/cakemail/approval-2026-09-12",
    approvalSha256: "b".repeat(64),
  };
  await withEnvironment(
    {
      ...VALID_CAKEMAIL_ENV,
      CAKEMAIL_AUDIENCE_MODE: "written_exception",
      CAKEMAIL_PROSPECTING_APPROVED: "true",
      CAKEMAIL_PROSPECTING_APPROVAL_REFERENCE:
        audiencePolicy.approvalReference,
      CAKEMAIL_PROSPECTING_APPROVAL_SHA256:
        audiencePolicy.approvalSha256,
      CAKEMAIL_ACTIVATION_BINDING_JSON: activationBinding({ audiencePolicy }),
    },
    () => {
      assert.deepEqual(cakemailConfig().audiencePolicy, audiencePolicy);
      assert.equal(outboundTransportOperational(), true);
    },
  );
});

test("fails closed when written-exception approval evidence is absent or malformed", async () => {
  const audiencePolicy = {
    mode: "written_exception",
    approvalReference: "legal/cakemail/approval-2026-09-12",
    approvalSha256: "b".repeat(64),
  };
  const valid = {
    ...VALID_CAKEMAIL_ENV,
    CAKEMAIL_AUDIENCE_MODE: "written_exception",
    CAKEMAIL_PROSPECTING_APPROVED: "true",
    CAKEMAIL_PROSPECTING_APPROVAL_REFERENCE:
      audiencePolicy.approvalReference,
    CAKEMAIL_PROSPECTING_APPROVAL_SHA256: audiencePolicy.approvalSha256,
    CAKEMAIL_ACTIVATION_BINDING_JSON: activationBinding({ audiencePolicy }),
  };
  for (const name of [
    "CAKEMAIL_PROSPECTING_APPROVED",
    "CAKEMAIL_PROSPECTING_APPROVAL_REFERENCE",
    "CAKEMAIL_PROSPECTING_APPROVAL_SHA256",
  ]) {
    const withoutRequiredValue = Object.fromEntries(
      Object.entries(valid).filter(([entry]) => entry !== name),
    );
    await withEnvironment(withoutRequiredValue, () => {
      assert.throws(cakemailConfig, new RegExp(name, "u"));
      assert.equal(outboundTransportOperational(), false);
    });
  }
  for (const [name, value] of [
    ["CAKEMAIL_PROSPECTING_APPROVED", "false"],
    ["CAKEMAIL_PROSPECTING_APPROVAL_REFERENCE", "contains spaces"],
    ["CAKEMAIL_PROSPECTING_APPROVAL_REFERENCE", "x".repeat(257)],
    ["CAKEMAIL_PROSPECTING_APPROVAL_SHA256", "B".repeat(64)],
    ["CAKEMAIL_PROSPECTING_APPROVAL_SHA256", "b".repeat(63)],
  ]) {
    await withEnvironment({ ...valid, [name]: value }, () => {
      assert.throws(cakemailConfig, new RegExp(`${name} is invalid`, "u"));
      assert.equal(outboundTransportOperational(), false);
    });
  }
});

test("permission/relationship mode rejects stale exception approval settings", async () => {
  for (const values of [
    { CAKEMAIL_PROSPECTING_APPROVED: "true" },
    {
      CAKEMAIL_PROSPECTING_APPROVAL_REFERENCE:
        "legal/cakemail/approval-2026-09-12",
    },
    { CAKEMAIL_PROSPECTING_APPROVAL_SHA256: "b".repeat(64) },
  ]) {
    await withEnvironment({ ...VALID_CAKEMAIL_ENV, ...values }, () => {
      assert.throws(cakemailConfig, /Cakemail audience policy is invalid/u);
      assert.equal(outboundTransportOperational(), false);
    });
  }
});

test("invalidates approvals when a bound Cakemail transport value changes", async () => {
  for (const values of [
    { ...VALID_CAKEMAIL_ENV, CAKEMAIL_ACCOUNT_ID: "18" },
    { ...VALID_CAKEMAIL_ENV, CAKEMAIL_LIST_ID: "24" },
    { ...VALID_CAKEMAIL_ENV, CAKEMAIL_CONTENT_MODE: "text" },
    {
      ...VALID_CAKEMAIL_ENV,
      CAKEMAIL_SENDER_ID_ALEXIS: "different-sender",
    },
    {
      ...VALID_CAKEMAIL_ENV,
      CAKEMAIL_AUDIENCE_MODE: "written_exception",
      CAKEMAIL_PROSPECTING_APPROVED: "true",
      CAKEMAIL_PROSPECTING_APPROVAL_REFERENCE:
        "legal/cakemail/approval-2026-09-12",
      CAKEMAIL_PROSPECTING_APPROVAL_SHA256: "b".repeat(64),
    },
    {
      ...VALID_CAKEMAIL_ENV,
      CAKEMAIL_AUDIENCE_MODE: "written_exception",
      CAKEMAIL_PROSPECTING_APPROVED: "true",
      CAKEMAIL_PROSPECTING_APPROVAL_REFERENCE:
        "legal/cakemail/approval-2026-09-13",
      CAKEMAIL_PROSPECTING_APPROVAL_SHA256: "b".repeat(64),
      CAKEMAIL_ACTIVATION_BINDING_JSON: activationBinding({
        audiencePolicy: {
          mode: "written_exception",
          approvalReference: "legal/cakemail/approval-2026-09-12",
          approvalSha256: "b".repeat(64),
        },
      }),
    },
    {
      ...VALID_CAKEMAIL_ENV,
      CAKEMAIL_AUDIENCE_MODE: "written_exception",
      CAKEMAIL_PROSPECTING_APPROVED: "true",
      CAKEMAIL_PROSPECTING_APPROVAL_REFERENCE:
        "legal/cakemail/approval-2026-09-12",
      CAKEMAIL_PROSPECTING_APPROVAL_SHA256: "c".repeat(64),
      CAKEMAIL_ACTIVATION_BINDING_JSON: activationBinding({
        audiencePolicy: {
          mode: "written_exception",
          approvalReference: "legal/cakemail/approval-2026-09-12",
          approvalSha256: "b".repeat(64),
        },
      }),
    },
    {
      ...VALID_CAKEMAIL_ENV,
      CAKEMAIL_ACTIVATION_BINDING_JSON: JSON.stringify({
        ...JSON.parse(activationBinding()),
        extra: true,
      }),
    },
    {
      ...VALID_CAKEMAIL_ENV,
      CAKEMAIL_ACTIVATION_BINDING_JSON: activationBinding({
        audiencePolicy: {
          mode: "permission_relationship",
          approvalReference: "stale/exception-reference",
        },
      }),
    },
  ]) {
    await withEnvironment(values, () => {
      assert.throws(
        cakemailConfig,
        /CAKEMAIL_ACTIVATION_BINDING_JSON is invalid/u,
      );
      assert.equal(outboundTransportOperational(), false);
    });
  }
});

test("rejects malformed Cakemail credentials, IDs, mode, and safety gates", async (t) => {
  const invalidCases = [
    ["CAKEMAIL_PAT", `ck_pat_${"A".repeat(40)}`],
    ["CAKEMAIL_PAT", `ck_pat_${"a".repeat(39)}`],
    ["CAKEMAIL_ACCOUNT_ID", "0"],
    ["CAKEMAIL_ACCOUNT_ID", "1.5"],
    ["CAKEMAIL_LIST_ID", "-1"],
    ["CAKEMAIL_CONTENT_MODE", "multipart"],
    ["CAKEMAIL_AUDIENCE_MODE", "all_contacts"],
    ["CAKEMAIL_SENDER_ID_BONJOUR", `sender\nforged`],
    ["CAKEMAIL_SENDER_ID_ALEXIS", "x".repeat(129)],
    ["CAKEMAIL_LIST_POLICY_ACCEPTED", "false"],
    ["CAKEMAIL_TRACKING_DOMAIN_READY", "TRUE"],
    ["CAKEMAIL_HEADER_PRESERVATION_CONFIRMED", "false"],
    ["CAKEMAIL_DKIM_ALIGNMENT_CONFIRMED", "1"],
  ];

  for (const [name, value] of invalidCases) {
    await t.test(name, async () => {
      await withEnvironment(
        { ...VALID_CAKEMAIL_ENV, [name]: value },
        () => {
          assert.throws(cakemailConfig, new RegExp(`${name} is invalid`, "u"));
          assert.equal(outboundTransportOperational(), false);
        },
      );
    });
  }
});

test("requires every Cakemail value without including secret material in errors", async () => {
  for (const name of Object.keys(VALID_CAKEMAIL_ENV).filter(
    (entry) =>
      entry !== "CRM_OUTBOUND_PROVIDER" &&
      entry !== "MAILGUN_WEBHOOK_SIGNING_KEY" &&
      entry !== "CAKEMAIL_WEBHOOK_SECRETS_JSON" &&
      entry !== "CAKEMAIL_PROSPECTING_APPROVED",
  )) {
    await withEnvironment(
      Object.fromEntries(
        Object.entries(VALID_CAKEMAIL_ENV).filter(([entry]) => entry !== name),
      ),
      () => {
        let error;
        try {
          cakemailConfig();
        } catch (caught) {
          error = caught;
        }
        assert.ok(error instanceof Error);
        assert.match(error.message, new RegExp(name, "u"));
        assert.doesNotMatch(error.message, /ck_pat_[a-f0-9]+/u);
      },
    );
  }
});

test("keeps Mailgun inbound verification mandatory for either outbound provider", async () => {
  await withEnvironment(
    {
      MAILGUN_DOMAIN: "27pm.org",
      MAILGUN_SENDING_KEY: "mailgun-test-key",
    },
    () => assert.equal(outboundTransportOperational(), false),
  );

  const withoutWebhookKey = { ...VALID_CAKEMAIL_ENV };
  delete withoutWebhookKey.MAILGUN_WEBHOOK_SIGNING_KEY;
  await withEnvironment(withoutWebhookKey, () => {
    assert.doesNotThrow(outboundTransportConfig);
    assert.throws(
      requireOutboundOperationalConfig,
      /MAILGUN_WEBHOOK_SIGNING_KEY is unavailable/u,
    );
    assert.equal(outboundTransportOperational(), false);
  });
});

test("requires every event-bound Cakemail secret before enabling outbound sends", async () => {
  const withoutCakemailWebhook = { ...VALID_CAKEMAIL_ENV };
  delete withoutCakemailWebhook.CAKEMAIL_WEBHOOK_SECRETS_JSON;
  await withEnvironment(withoutCakemailWebhook, () => {
    assert.throws(
      outboundTransportConfig,
      /CAKEMAIL_WEBHOOK_SECRETS_JSON is invalid/u,
    );
    assert.equal(outboundTransportOperational(), false);
  });

  await withEnvironment(
    {
      ...VALID_CAKEMAIL_ENV,
      CAKEMAIL_WEBHOOK_SECRETS_JSON:
        '{"Email.Delivered":["delivered-secret"]}',
    },
    () => {
      assert.throws(
        outboundTransportConfig,
        /CAKEMAIL_WEBHOOK_SECRETS_JSON is invalid/u,
      );
      assert.equal(outboundTransportOperational(), false);
    },
  );
});
