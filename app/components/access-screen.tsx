import Image from "next/image";
import { chatGPTSignInPath, chatGPTSignOutPath } from "../chatgpt-auth";

type AccessScreenProps = {
  state: "signed-out" | "denied";
  email?: string;
};

export function AccessScreen({ state, email }: AccessScreenProps) {
  const signedOut = state === "signed-out";

  return (
    <main className="access-screen">
      <div className="access-brand" aria-label="27PM">
        <Image
          src="/brand/27-mark.png"
          alt=""
          width={52}
          height={52}
          priority
          unoptimized
        />
        <span>27PM</span>
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
        <a
          className="primary-action"
          href={
            signedOut
              ? chatGPTSignInPath("/")
              : chatGPTSignOutPath("/")
          }
        >
          {signedOut ? "Se connecter avec ChatGPT" : "Changer de compte"}
        </a>
      </section>
      <p className="access-footnote">
        Les données clients ne sont jamais publiées sur le site 27pm.org.
      </p>
    </main>
  );
}
