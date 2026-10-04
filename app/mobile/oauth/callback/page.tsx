import Link from "next/link";
import type { Metadata } from "next";

export const dynamic = "force-dynamic";
export const metadata: Metadata = {
  title: "Retour à l’app — 27PM CRM",
  referrer: "no-referrer",
  robots: { index: false, follow: false },
};

export default function MobileOAuthFallbackPage() {
  return (
    <main className="mobile-authorization-screen">
      <section className="mobile-authorization-panel">
        <p className="mobile-authorization-kicker">27PM CRM · Connexion mobile</p>
        <h1>Retour à l’application impossible</h1>
        <p>
          Aucun code n’est affiché ici. Installe ou mets à jour l’app 27PM CRM,
          puis relance la connexion depuis l’appareil.
        </p>
        <Link className="secondary-action" href="/">Retour au CRM</Link>
      </section>
    </main>
  );
}
