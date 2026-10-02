import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  authConfig,
  WEB_SESSION_MAX_AGE_SECONDS,
} from "../auth.ts";
import {
  authJsSignInPath,
  authJsSignOutPath,
  googleIdentityAllowed,
  safeAuthRedirect,
  safeRelativeReturnPath,
  webIdentityProvider,
} from "../lib/web-identity.ts";

test("web identity defaults to Sites and only opts into Google explicitly", () => {
  assert.equal(webIdentityProvider(undefined), "sites");
  assert.equal(webIdentityProvider(""), "sites");
  assert.equal(webIdentityProvider("sites"), "sites");
  assert.equal(webIdentityProvider(" google "), "google");
  assert.equal(webIdentityProvider("GOOGLE"), "google");
  assert.equal(webIdentityProvider("other"), "disabled");
});

test("Google identities require the enabled provider, verified email, and exact allowlist membership", () => {
  const allowedProfile = {
    email: " Alexis@27PM.org ",
    email_verified: true,
  };

  assert.equal(
    googleIdentityAllowed(allowedProfile, "alexis@27pm.org", "google"),
    true,
  );
  assert.equal(
    googleIdentityAllowed(
      allowedProfile,
      "admin@27pm.org, alexis@27pm.org",
      "google",
    ),
    true,
  );
  assert.equal(
    googleIdentityAllowed(
      { ...allowedProfile, email_verified: false },
      "alexis@27pm.org",
      "google",
    ),
    false,
  );
  assert.equal(
    googleIdentityAllowed(allowedProfile, "other@27pm.org", "google"),
    false,
  );
  assert.equal(googleIdentityAllowed(allowedProfile, "", "google"), false);
  assert.equal(
    googleIdentityAllowed(allowedProfile, "alexis@27pm.org", "sites"),
    false,
  );
});

test("Auth.js return targets remain relative and avoid every authentication endpoint", () => {
  const allowed = "/mobile/authorize?state=abc#confirm";
  assert.equal(safeRelativeReturnPath(allowed), allowed);
  assert.equal(authJsSignInPath(allowed), `/api/auth/signin?callbackUrl=${encodeURIComponent(allowed)}`);
  assert.equal(authJsSignOutPath(allowed), `/api/auth/signout?callbackUrl=${encodeURIComponent(allowed)}`);

  for (const unsafe of [
    "https://attacker.example/path",
    "//attacker.example/path",
    "/\\attacker.example/path",
    "/api/auth/signin",
    "/api/auth/callback/google",
    "/signin-with-chatgpt",
    "/signout-with-chatgpt",
    "/callback",
  ]) {
    assert.equal(safeRelativeReturnPath(unsafe), "/");
  }

  assert.equal(
    safeAuthRedirect("/mobile/sessions", "https://crm.27pm.org"),
    "https://crm.27pm.org/mobile/sessions",
  );
  assert.equal(
    safeAuthRedirect(
      "https://crm.27pm.org/mobile/sessions?active=1",
      "https://crm.27pm.org",
    ),
    "https://crm.27pm.org/mobile/sessions?active=1",
  );
  assert.equal(
    safeAuthRedirect("https://attacker.example/", "https://crm.27pm.org"),
    "https://crm.27pm.org/",
  );
});

test("Auth.js server configuration wires Google verification and the operator allowlist", async () => {
  const [authSource, routeSource] = await Promise.all([
    readFile(new URL("../auth.ts", import.meta.url), "utf8"),
    readFile(
      new URL("../app/api/auth/[...nextauth]/route.ts", import.meta.url),
      "utf8",
    ),
  ]);

  assert.match(authSource, /Google/u);
  assert.match(authSource, /googleIdentityAllowed\(/u);
  assert.match(authSource, /process\.env\.CRM_ADMIN_EMAILS/u);
  assert.match(authSource, /process\.env\.CRM_WEB_IDENTITY_PROVIDER/u);
  assert.match(authSource, /strategy:\s*["']jwt["']/u);
  assert.match(authSource, /maxAge:\s*WEB_SESSION_MAX_AGE_SECONDS/u);
  assert.match(routeSource, /handlers/u);
  assert.match(routeSource, /GET/u);
  assert.match(routeSource, /POST/u);
});

test("Auth.js callbacks reject stale or unverified identities and expose a minimal session", async () => {
  const originalProvider = process.env.CRM_WEB_IDENTITY_PROVIDER;
  const originalAllowlist = process.env.CRM_ADMIN_EMAILS;
  process.env.CRM_WEB_IDENTITY_PROVIDER = "google";
  process.env.CRM_ADMIN_EMAILS = "alexis@27pm.org";

  try {
    const callbacks = authConfig.callbacks;
    assert.ok(callbacks?.signIn);
    assert.ok(callbacks?.jwt);
    assert.ok(callbacks?.session);
    assert.equal(authConfig.session?.strategy, "jwt");
    assert.equal(authConfig.session?.maxAge, WEB_SESSION_MAX_AGE_SECONDS);
    assert.equal(WEB_SESSION_MAX_AGE_SECONDS, 8 * 60 * 60);

    assert.equal(
      await callbacks.signIn({
        account: { provider: "google" },
        profile: { email: "alexis@27pm.org", email_verified: true },
        user: { id: "google-user" },
      }),
      true,
    );
    assert.equal(
      await callbacks.signIn({
        account: { provider: "google" },
        profile: { email: "alexis@27pm.org", email_verified: false },
        user: { id: "google-user" },
      }),
      false,
    );

    const token = await callbacks.jwt({
      token: { email: "Alexis@27PM.org", name: "Alexis", picture: "unused" },
      account: null,
      user: { id: "google-user" },
    });
    assert.deepEqual(token, {
      email: "alexis@27pm.org",
      name: "Alexis",
      picture: undefined,
    });

    const session = await callbacks.session({
      session: {
        expires: "2026-10-02T20:00:00.000Z",
        user: { email: "should-not-leak@example.com", image: "unused" },
      },
      token,
    });
    assert.deepEqual(session, {
      expires: "2026-10-02T20:00:00.000Z",
      user: {
        email: "alexis@27pm.org",
        name: "Alexis",
        image: null,
      },
    });

    process.env.CRM_WEB_IDENTITY_PROVIDER = "sites";
    assert.equal(
      await callbacks.jwt({
        token: { email: "alexis@27pm.org" },
        account: null,
        user: { id: "google-user" },
      }),
      null,
    );
  } finally {
    if (originalProvider === undefined) {
      delete process.env.CRM_WEB_IDENTITY_PROVIDER;
    } else {
      process.env.CRM_WEB_IDENTITY_PROVIDER = originalProvider;
    }
    if (originalAllowlist === undefined) {
      delete process.env.CRM_ADMIN_EMAILS;
    } else {
      process.env.CRM_ADMIN_EMAILS = originalAllowlist;
    }
  }
});
