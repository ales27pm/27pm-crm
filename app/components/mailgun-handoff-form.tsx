"use client";

import { useState, type FormEvent } from "react";
import Link from "next/link";
import {
  MAILGUN_HANDOFF_EXPIRES_AT,
  MAILGUN_HANDOFF_KEY_FINGERPRINT,
  MAILGUN_HANDOFF_PUBLIC_KEY_PEM,
} from "@/lib/mailgun-handoff";

type SubmitState = "idle" | "encrypting" | "sent" | "error";

export function MailgunHandoffForm({ operatorEmail }: { operatorEmail: string }) {
  const [accountKey, setAccountKey] = useState("");
  const [state, setState] = useState<SubmitState>("idle");
  const [message, setMessage] = useState("");

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const normalized = accountKey.trim();
    if (!/^[!-~]{20,190}$/u.test(normalized)) {
      setState("error");
      setMessage("La clé ne ressemble pas à une clé d’API Mailgun complète.");
      return;
    }

    setState("encrypting");
    setMessage("Chiffrement local en cours…");
    try {
      const ciphertext = await encryptForHandoff(normalized);
      const response = await fetch("/api/admin/mailgun-handoff", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ciphertext,
          keyFingerprint: MAILGUN_HANDOFF_KEY_FINGERPRINT,
        }),
      });
      if (!response.ok) throw new Error(`handoff_${response.status}`);

      setAccountKey("");
      setState("sent");
      setMessage(
        "Clé chiffrée transmise. Reviens dans ChatGPT et écris « fait ». Rien n’a été placé dans Git.",
      );
    } catch {
      setState("error");
      setMessage(
        "La transmission n’a pas fonctionné. Recharge la page et réessaie avant l’expiration.",
      );
    }
  }

  return (
    <main className="handoff-screen">
      <header className="handoff-header">
        <Link className="handoff-brand" href="/" aria-label="Retour au CRM 27PM">
          <span aria-hidden="true">27</span>
          <strong>Configuration Mailgun</strong>
        </Link>
        <span>{operatorEmail}</span>
      </header>

      <section className="handoff-layout" aria-labelledby="handoff-title">
        <div className="handoff-intro">
          <p className="eyebrow">Passage sécurisé · usage unique</p>
          <h1 id="handoff-title">Le clavier reste dans Safari.</h1>
          <p>
            Une seule clé temporaire suffit. Elle est chiffrée sur ton iPhone
            avant de quitter cette page; le CRM ne reçoit jamais sa valeur en clair.
          </p>
        </div>

        <ol className="handoff-steps">
          <li>
            <span>01</span>
            <div>
              <h2>Créer la clé temporaire</h2>
              <p>
                Ouvre Mailgun dans Safari, va à <strong>API Security</strong>, puis
                crée une clé nommée <code>27PM CRM bootstrap</code>. Choisis le rôle
                Admin si Mailgun le demande.
              </p>
              <a
                className="secondary-action"
                href="https://app.mailgun.com/settings/api_security"
                target="_blank"
                rel="noreferrer"
              >
                Ouvrir Mailgun dans Safari
              </a>
            </div>
          </li>
          <li>
            <span>02</span>
            <div>
              <h2>Coller et chiffrer</h2>
              <p>
                Reviens ici et colle la clé une seule fois. Ne la mets ni dans
                ChatGPT, ni dans Git, ni dans une capture d’écran.
              </p>
              <form className="handoff-form" onSubmit={submit}>
                <label htmlFor="mailgun-account-key">Clé d’API temporaire</label>
                <input
                  id="mailgun-account-key"
                  name="mailgun-account-key"
                  type="password"
                  autoComplete="off"
                  autoCapitalize="none"
                  spellCheck={false}
                  value={accountKey}
                  onChange={(event) => {
                    setAccountKey(event.target.value);
                    if (state !== "idle") {
                      setState("idle");
                      setMessage("");
                    }
                  }}
                  disabled={state === "encrypting" || state === "sent"}
                  required
                />
                <button
                  className="primary-action"
                  type="submit"
                  disabled={state === "encrypting" || state === "sent"}
                >
                  {state === "encrypting" ? "Chiffrement…" : "Chiffrer et transmettre"}
                </button>
                <p className="handoff-status" data-state={state} aria-live="polite">
                  {message}
                </p>
              </form>
            </div>
          </li>
          <li>
            <span>03</span>
            <div>
              <h2>Je termine l’intégration</h2>
              <p>
                Je créerai ensuite la clé d’envoi limitée à <code>27pm.org</code>,
                récupérerai la signature des webhooks, déposerai les deux valeurs
                dans le coffre du CRM, puis révoquerai la clé temporaire.
              </p>
            </div>
          </li>
        </ol>

        <aside className="handoff-proof">
          <strong>Ce passage expire</strong>
          <time dateTime={MAILGUN_HANDOFF_EXPIRES_AT}>
            26 août 2026 à 8 h, heure de Montréal
          </time>
          <span>Empreinte : {MAILGUN_HANDOFF_KEY_FINGERPRINT.slice(0, 12)}…</span>
        </aside>
      </section>
    </main>
  );
}

async function encryptForHandoff(value: string): Promise<string> {
  const publicKey = await crypto.subtle.importKey(
    "spki",
    pemBody(MAILGUN_HANDOFF_PUBLIC_KEY_PEM),
    { name: "RSA-OAEP", hash: "SHA-256" },
    false,
    ["encrypt"],
  );
  const ciphertext = await crypto.subtle.encrypt(
    { name: "RSA-OAEP" },
    publicKey,
    new TextEncoder().encode(value),
  );
  return bytesToBase64(new Uint8Array(ciphertext));
}

function pemBody(pem: string): ArrayBuffer {
  const encoded = pem.replace(/-----[^-]+-----|\s+/gu, "");
  const binary = atob(encoded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0)).buffer;
}

function bytesToBase64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}
