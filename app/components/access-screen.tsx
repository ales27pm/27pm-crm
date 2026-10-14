import Image from "next/image";
import {
  webIdentityProvider,
  webSignInPath,
  webSignOutPath,
} from "../chatgpt-auth";
import { Illustration } from "./visual-assets";

type AccessScreenProps = {
  state: "signed-out" | "denied";
  email?: string;
  returnTo?: string;
};

export function AccessScreen({
  state,
  email,
  returnTo = "/",
}: AccessScreenProps) {
  const signedOut = state === "signed-out";
  const identityProvider = webIdentityProvider();
  const signInLabel =
    identityProvider === "google"
      ? "Se connecter avec Google"
      : "Se connecter avec ChatGPT";
  const authenticationAvailable = identityProvider !== "disabled";

  return (
    <main className="access-screen" data-state={state}>
      <div className="access-brand">
        <Image
          src="/visual-assets/brand/27pm-crm-horizontal.svg"
          alt="27PM CRM"
          width={150}
          height={48}
          priority
          unoptimized
        />
      </div>
      <section className="access-panel" aria-labelledby="access-title">
        <h1 id="access-title">
          {signedOut ? "Votre studio, en un seul endroit." : "Accès non autorisé."}
        </h1>
        <p>
          {signedOut
            ? "La boîte courriel, les contacts, les projets et les suivis de 27PM sont privés."
            : `${email ?? "Ce compte"} n’est pas dans la liste des opérateurs du CRM.`}
        </p>
        {authenticationAvailable ? (
          <a
            className="primary-action"
            target="_top"
            href={
              signedOut
                ? webSignInPath(returnTo, identityProvider)
                : webSignOutPath(returnTo, identityProvider)
            }
          >
            {signedOut ? signInLabel : "Changer de compte"}
          </a>
        ) : (
          <span className="primary-action" aria-disabled="true">
            Connexion indisponible
          </span>
        )}
      </section>
      <div className="access-visual" aria-hidden="true">
        {signedOut ? (
          <picture className="access-picture">
            <source
              media="(max-width: 760px)"
              srcSet="/visual-assets/backgrounds/mobile-flow-ivory.png"
            />
            <img
              className="access-background"
              src="/visual-assets/backgrounds/login-flow-ivory.png"
              alt=""
              width={1536}
              height={1024}
              decoding="async"
              fetchPriority="high"
            />
          </picture>
        ) : (
          <Illustration className="crm-empty-art" name="access-denied" loading="eager" />
        )}
      </div>
      <p className="access-footnote">
        Les données clients ne sont jamais publiées sur le site 27pm.org.
      </p>
    </main>
  );
}
