import NextAuth, { type NextAuthConfig } from "next-auth";
import Google from "next-auth/providers/google";

import { normalizeEmailAddress } from "@/lib/mailboxes";
import {
  googleIdentityAllowed,
  operatorEmailAllowed,
  safeAuthRedirect,
  webIdentityProvider,
} from "@/lib/web-identity";

export const WEB_SESSION_MAX_AGE_SECONDS = 8 * 60 * 60;

export const authConfig = {
  providers: [Google],
  session: {
    strategy: "jwt",
    maxAge: WEB_SESSION_MAX_AGE_SECONDS,
    updateAge: 15 * 60,
  },
  jwt: {
    maxAge: WEB_SESSION_MAX_AGE_SECONDS,
  },
  callbacks: {
    signIn({ account, profile }) {
      return (
        account?.provider === "google" &&
        googleIdentityAllowed(
          profile,
          process.env.CRM_ADMIN_EMAILS,
          process.env.CRM_WEB_IDENTITY_PROVIDER,
        )
      );
    },
    jwt({ token, account, profile }) {
      if (webIdentityProvider(process.env.CRM_WEB_IDENTITY_PROVIDER) !== "google") {
        return null;
      }
      if (account) {
        if (
          account.provider !== "google" ||
          !googleIdentityAllowed(
            profile,
            process.env.CRM_ADMIN_EMAILS,
            process.env.CRM_WEB_IDENTITY_PROVIDER,
          )
        ) {
          return null;
        }
      } else if (
        !operatorEmailAllowed(token.email, process.env.CRM_ADMIN_EMAILS)
      ) {
        return null;
      }

      const email = normalizeEmailAddress(
        typeof profile?.email === "string" ? profile.email : token.email ?? "",
      );
      if (!email) return null;

      token.email = email;
      token.picture = undefined;
      return token;
    },
    session({ session, token }) {
      const email = normalizeEmailAddress(token.email ?? "");
      if (
        webIdentityProvider(process.env.CRM_WEB_IDENTITY_PROVIDER) !== "google" ||
        !email ||
        !operatorEmailAllowed(email, process.env.CRM_ADMIN_EMAILS)
      ) {
        return { expires: session.expires };
      }

      return {
        expires: session.expires,
        user: {
          email,
          name: token.name ?? email,
          image: null,
        },
      };
    },
    redirect({ url, baseUrl }) {
      return safeAuthRedirect(url, baseUrl);
    },
  },
} satisfies NextAuthConfig;

export const { handlers, auth } = NextAuth(authConfig);
