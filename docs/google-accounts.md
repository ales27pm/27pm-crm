# Google identity and Search Console for 27PM

Use `admin@27pm.org` as the operational Google identity. Do not use
`bonjour@27pm.org` or `alexis@27pm.org`: client correspondence and account
ownership/recovery must remain separate.

Creating a Google Account with an existing address creates a Google identity;
it does **not** create a Gmail mailbox, change the Mailgun MX records, or move
mail away from the CRM. Google documents the existing-address flow in
[Create a Google Account](https://support.google.com/accounts/answer/27441?hl=en).

## Before starting

- Confirm `admin@27pm.org` can receive a message in the CRM's admin mailbox.
- Confirm the admin mailbox is not visible in lead or client views.
- Use a private browser window to avoid attaching ownership to the wrong Google
  session.
- Have an independent recovery method and approved password manager available.
  A recovery address should not be `bonjour@27pm.org` or `alexis@27pm.org`.
- If Google says the address is already in use, stop and use account recovery;
  do not create a second identity or switch to a personal Gmail account.

## Create the Google Account interactively

Button labels can vary slightly by locale. Complete the flow in the browser:

1. Open the [Google Account sign-up page](https://accounts.google.com/signup).
2. Select **Create account**, then the appropriate individual/business option
   for the agency operator.
3. Select **Use your existing email** (or **Use my current email address
   instead**).
4. Enter exactly `admin@27pm.org`. Do not enter `bonjour@27pm.org` and do not
   choose a new `@gmail.com` address.
5. Retrieve the verification code from the CRM's **admin** mailbox and enter it
   in the Google flow. Do not copy the message into a client conversation.
6. Set a unique password through the approved password manager.
7. Add an independent recovery method, enable two-step verification, register a
   passkey/security key where available, and store backup codes securely.
8. Sign out and prove that `admin@27pm.org` can sign back in at
   `https://myaccount.google.com/` with the Google Account password.
9. Review security events and contact/recovery addresses. Confirm there is no
   unintended Gmail inbox and that notices arrive in the CRM admin mailbox.

Google also documents that a non-Gmail alternate address can be used for
sign-in, recovery, and notifications in
[Use another email to sign in](https://support.google.com/accounts/answer/176347?hl=en).

## Claim the `27pm.org` Search Console domain property

Google states that a **Domain property** covers all protocols and subdomains and
can be verified only through the domain provider. Its complete official flow is
in [Verify site ownership](https://support.google.com/webmasters/answer/9008080?hl=en).

1. In the same private browser session, sign in to
   [Google Search Console](https://search.google.com/search-console/) as
   `admin@27pm.org`.
2. Select **Add property** and choose **Domain**, not **URL prefix**.
3. Enter `27pm.org` only: no `https://`, `www`, path, or trailing slash.
4. Choose DNS verification and copy the exact Search Console TXT value. It will
   resemble `google-site-verification=...`; do not alter or publish it in this
   repository.
5. In Squarespace DNS, add a **new** TXT record at the apex (`@` or a blank host,
   as Squarespace requires) with the exact value Google supplied.
6. Do not replace, merge, or delete any existing MX, SPF, DKIM, DMARC, CAA,
   GitHub Pages, or other Google verification record. The Search Console token
   is an additional TXT record, not part of the SPF value.
7. Return to Search Console and select **Verify**. Manual DNS publication may
   take from minutes to a few days; if verification fails, inspect the public
   TXT answer and retry without DNS churn.
8. Leave the successful verification TXT record in DNS permanently. Google
   periodically rechecks ownership and can revoke access after the token is
   removed.
9. In **Settings → Users and permissions**, confirm
   `admin@27pm.org` is a verified owner. Add a separately secured backup owner
   only if agency policy requires continuity; never overwrite another owner's
   verification token.
10. Record the property, verified owner, recovery owner, and verification date
    in the private operations register. Do not record passwords, backup codes,
    or the Mailgun API key.

The Mailgun route provisioner never performs step 5. DNS ownership remains an
interactive registrar operation with an explicit review of the existing zone.

## Identity separation checklist

- `admin@27pm.org`: Google Account, Search Console ownership, service recovery,
  vendor/security notices.
- `bonjour@27pm.org`: client and prospect correspondence only; no Google
  ownership or recovery role.
- A personal Gmail account: at most a documented backup owner, never the sole
  unrecorded owner of agency property.
- Search Console access does not grant CRM operator access; the CRM still uses
  ChatGPT sign-in plus its server-side `CRM_ADMIN_EMAILS` allowlist.
- CRM access does not prove Search Console ownership; Google independently
  validates the persistent DNS token.

When an operator leaves, add and verify the replacement owner first, test its
access and recovery, then remove the former user's Search Console permission
and Google recovery role. Do not remove the domain token until another verified
ownership method is confirmed.
