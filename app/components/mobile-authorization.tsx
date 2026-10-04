"use client";

import Link from "next/link";
import { useState } from "react";

type Props = {
  operatorEmail: string;
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  state: string;
  deviceName: string | null;
  denialUrl: string;
};

export function MobileAuthorizationApproval(props: Props) {
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);

  async function authorize() {
    setBusy(true);
    setStatus("Création de l’autorisation sécurisée…");
    try {
      const response = await fetch("/api/mobile/authorize", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          responseType: "code",
          clientId: props.clientId,
          redirectUri: props.redirectUri,
          codeChallenge: props.codeChallenge,
          codeChallengeMethod: "S256",
          state: props.state,
          deviceName: props.deviceName,
        }),
      });
      const payload: unknown = await response.json();
      if (
        !response.ok ||
        !payload ||
        typeof payload !== "object" ||
        !("redirectUrl" in payload) ||
        typeof payload.redirectUrl !== "string"
      ) throw new Error("authorization_failed");
      setStatus("Autorisation créée. Retour à l’application…");
      window.location.assign(payload.redirectUrl);
    } catch {
      setStatus("L’autorisation n’a pas été créée. Réessaie depuis l’application.");
      setBusy(false);
    }
  }

  return (
    <main className="mobile-authorization-screen">
      <section className="mobile-authorization-panel" aria-labelledby="mobile-auth-title">
        <p className="mobile-authorization-kicker">27PM CRM · Connexion mobile</p>
        <h1 id="mobile-auth-title">Autoriser cet appareil</h1>
        <p>
          L’application pourra consulter le tableau de bord et mettre à jour le
          travail CRM. Elle ne pourra pas envoyer de courriels ni modifier les
          intégrations d’administration.
        </p>
        <dl className="settings-facts">
          <div><dt>Compte vérifié</dt><dd>{props.operatorEmail}</dd></div>
          <div><dt>Appareil</dt><dd>{props.deviceName ?? "Appareil iOS"}</dd></div>
          <div><dt>Accès</dt><dd>Lecture et mise à jour du travail</dd></div>
        </dl>
        <button
          className="primary-action"
          disabled={busy}
          onClick={() => void authorize()}
          type="button"
        >
          {busy ? "Autorisation…" : "Autoriser et retourner à l’app"}
        </button>
        <a className="secondary-action" href={props.denialUrl}>Annuler</a>
        <Link className="secondary-action" href="/mobile/sessions">
          Gérer les appareils
        </Link>
        <p aria-live="polite" className="mobile-authorization-status" role="status">
          {status}
        </p>
      </section>
    </main>
  );
}

export function MobileAuthorizationUnavailable({
  reason,
}: {
  reason: "invalid" | "unconfigured";
}) {
  return (
    <main className="mobile-authorization-screen">
      <section className="mobile-authorization-panel" aria-labelledby="mobile-auth-title">
        <p className="mobile-authorization-kicker">27PM CRM · Connexion mobile</p>
        <h1 id="mobile-auth-title">Connexion impossible</h1>
        <p>
          {reason === "unconfigured"
            ? "La connexion mobile n’est pas encore configurée sur le serveur."
            : "La demande de connexion est invalide ou incomplète."}
        </p>
        <Link className="secondary-action" href="/">Retour au CRM</Link>
      </section>
    </main>
  );
}
