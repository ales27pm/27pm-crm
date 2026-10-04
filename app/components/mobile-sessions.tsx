"use client";

import Link from "next/link";
import { useState } from "react";
import type { MobileSessionSummary } from "@/lib/mobile-auth-store";

export function MobileSessionsManager({
  initialSessions,
}: {
  initialSessions: MobileSessionSummary[];
}) {
  const [sessions, setSessions] = useState(initialSessions);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [status, setStatus] = useState("");

  async function revoke(session: MobileSessionSummary) {
    if (!window.confirm(
      `Révoquer l’accès de ${session.deviceName ?? "cet appareil"} ?`,
    )) return;
    setBusyId(session.id);
    setStatus("Révocation en cours…");
    try {
      const response = await fetch("/api/mobile/sessions", {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionId: session.id }),
      });
      if (!response.ok) throw new Error("revocation_failed");
      setSessions((current) => current.filter(({ id }) => id !== session.id));
      setStatus("L’accès de l’appareil a été révoqué.");
    } catch {
      setStatus("La révocation n’a pas abouti. Recharge la page avant de réessayer.");
    } finally {
      setBusyId(null);
    }
  }

  return (
    <main className="mobile-authorization-screen">
      <section className="mobile-authorization-panel" aria-labelledby="mobile-sessions-title">
        <p className="mobile-authorization-kicker">27PM CRM · Sécurité mobile</p>
        <h1 id="mobile-sessions-title">Appareils autorisés</h1>
        <p>
          Révoque ici un appareil perdu ou que tu ne reconnais pas. Ses jetons
          d’accès cessent immédiatement de fonctionner.
        </p>
        {sessions.length === 0 ? (
          <p>Aucun appareil mobile actif.</p>
        ) : (
          <ul className="mobile-session-list">
            {sessions.map((session) => (
              <li key={session.id}>
                <div>
                  <strong>{session.deviceName ?? "Appareil iOS"}</strong>
                  <span>
                    Dernier renouvellement : {formatDate(session.lastRefreshedAt)}
                  </span>
                  <span>Expiration : {formatDate(session.expiresAt)}</span>
                </div>
                <button
                  className="secondary-action"
                  disabled={busyId !== null}
                  onClick={() => void revoke(session)}
                  type="button"
                >
                  {busyId === session.id ? "Révocation…" : "Révoquer"}
                </button>
              </li>
            ))}
          </ul>
        )}
        <Link className="secondary-action" href="/">Retour au CRM</Link>
        <p aria-live="polite" className="mobile-authorization-status" role="status">
          {status}
        </p>
      </section>
    </main>
  );
}

function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.valueOf())
    ? value
    : new Intl.DateTimeFormat("fr-CA", {
        dateStyle: "medium",
        timeStyle: "short",
      }).format(date);
}
