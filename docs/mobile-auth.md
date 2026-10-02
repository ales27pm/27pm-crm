# 27PM CRM mobile authorization

The native client must never authenticate with an operator email stored in an
Expo variable. `EXPO_PUBLIC_CRM_OPERATOR_EMAIL` must be removed. The only
required public server setting is:

```text
EXPO_PUBLIC_CRM_API_BASE_URL=https://crm.27pm.org
```

The fixed client ID `org.27pm.crm.mobile` and redirect
`https://crm.27pm.org/mobile/oauth/callback` are public protocol identifiers,
not secrets. The HTTPS callback must be an iOS Universal Link claimed by the
shipping app; a private-use URI scheme is deliberately rejected because any
installed app can register the same scheme.
The server must nevertheless pin the exact redirect in
`CRM_MOBILE_REDIRECT_URI`.

The client must treat `https://crm.27pm.org` as a compiled, exact allowlisted
origin, not a user-editable destination. It must validate HTTPS, host and port
before attaching any access or refresh token. If a stored or supplied API base
does not match exactly, purge local token material and fail closed.

## Server configuration

Set these only through the Sites runtime secret/configuration controls:

```text
CRM_MOBILE_REDIRECT_URI=https://crm.27pm.org/mobile/oauth/callback
CRM_MOBILE_TOKEN_SIGNING_KEY=<base64url encoding of at least 32 random bytes>
CRM_IOS_APP_ID=<Apple-Team-ID>.<iOS-bundle-identifier>
```

`CRM_MOBILE_TOKEN_SIGNING_KEY` must not appear in Git, Rork, Expo configuration,
logs, D1 or browser output. Before deployment, snapshot production D1 and apply
the packaged migrations `0015_chief_wilson_fisk.sql` through
`0017_wonderful_nomad.sql` in order through Sites. Do not run Wrangler against
the placeholder local database ID.

The server publishes `/.well-known/apple-app-site-association` only when
`CRM_IOS_APP_ID` is a valid application identifier. It publishes the same app
ID under both `applinks` and `webcredentials`. The iOS target must include the
matching `applinks:crm.27pm.org` and `webcredentials:crm.27pm.org`
associated-domain entitlements, and must create an
`ASWebAuthenticationSession.Callback.https` matcher for the exact host/path.
That API requires iOS 17.4 or later, which is the minimum for this flow. Do not
silently fall back to a private-use scheme. Verify the exact client library,
entitlements and callback on a physical device before enabling mobile sign-in.

## Client flow

1. Generate a PKCE verifier of 43–128 RFC 7636 unreserved characters, its S256
   base64url challenge, and an independent state value of at least 128 bits.
2. Keep the verifier and state on the device. Open the system authentication
   session at:

   ```text
   https://crm.27pm.org/mobile/authorize
     ?response_type=code
     &client_id=org.27pm.crm.mobile
     &redirect_uri=https%3A%2F%2Fcrm.27pm.org%2Fmobile%2Foauth%2Fcallback
     &code_challenge=<challenge>
     &code_challenge_method=S256
     &state=<state>
     &device_name=<display-only label>
   ```

3. Sites authenticates the browser. The approval screen derives the operator
   email from that session and creates a five-minute, single-use grant. The
   callback contains only `code` and the original `state`.
4. Reject a mismatched state. Exchange the code once:

   ```http
   POST /api/mobile/token
   Content-Type: application/json

   {
     "grantType": "authorization_code",
     "clientId": "org.27pm.crm.mobile",
     "redirectUri": "https://crm.27pm.org/mobile/oauth/callback",
     "code": "<callback code>",
     "codeVerifier": "<original verifier>"
   }
   ```

5. Store the opaque refresh token only in iOS Keychain/Expo SecureStore. Use
   the access token as `Authorization: Bearer <token>`. Never put either token
   in a URL, AsyncStorage, analytics, logs or an `EXPO_PUBLIC_*` value.
6. Before the 15-minute access token expires, rotate the refresh token:

   ```json
   {
     "grantType": "refresh_token",
     "clientId": "org.27pm.crm.mobile",
     "refreshToken": "<current refresh token>"
   }
   ```

   Replace the stored refresh token only after a successful response. Reusing
   any prior family token revokes the whole device session. If a refresh
   response is lost, do not retry the old token indefinitely: clear local
   tokens and start a new authorization.
7. On sign-out, `POST /api/mobile/logout` with the current refresh token, then
   delete local token material regardless of the response.

An operator can inspect and revoke a lost device at `/mobile/sessions` without
possessing its refresh token. The backing `GET` and same-origin `DELETE`
operations are available at `/api/mobile/sessions` and require the verified
Sites operator identity.

Mobile mutation audit entries retain the verified session identifier, so two
authorized devices using the same operator email remain distinguishable.

All token and authorization responses are `private, no-store` with a
`no-referrer` policy. Invalid grants use a non-enumerating error.

## Scope boundary

The issued session has exactly:

- `crm:dashboard:read` for `GET /api/dashboard`;
- `crm:work` for conversation, deal, intake review, interaction, strategy and
  task changes.

The native token is intentionally rejected by message sending, Mailgun and
Cakemail administration, canaries, compliance controls, privacy workflows,
account/contact creation, editing or deletion, imports and attachment access.
Those actions retain Sites identity and same-origin checks because account and
contact mutations can change suppression or compliance evidence.

## Current client handoff

The Rork/Expo source shown in the iOS screenshot is not present in this
repository. Export or clone that source before replacing its demo setup screen
with this flow. Do not make its existing email field functional; remove it.
