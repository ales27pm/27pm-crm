"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";

const ENDPOINT = "/api/integrations/exchange";
const FLOW_STORAGE_KEY = "27pm.exchange.connection-flow.v1";
const BINDER = /^[A-Za-z0-9_-]{43}$/u;
const FLOW_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

export type ExchangeConnectionStatus = {
  configured: boolean;
  status: "disconnected" | "connected" | "reauth_required";
  updatedAt?: string | null;
  mailFlowEnabled: false;
  cleanupPending?: boolean;
};

type BrowserFlow = { binder: string; flowId?: string };
type Action = "connect" | "finalize" | "check" | "disconnect";
type ApiResult =
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; ambiguous: boolean; error: string };

export function ExchangeConnection({
  initialStatus,
}: {
  initialStatus?: ExchangeConnectionStatus;
}) {
  const [connection, setConnection] = useState<ExchangeConnectionStatus | null>(initialStatus ?? null);
  const [busy, setBusy] = useState<Action | "load" | null>(initialStatus ? null : "load");
  const [notice, setNotice] = useState(initialStatus
    ? "État enregistré dans le CRM; aucune nouvelle vérification Microsoft n’a été effectuée."
    : "Lecture de l’état enregistré dans le CRM…");
  const [uncertain, setUncertain] = useState(false);
  const initialized = useRef(false);
  const operationPending = useRef(false);
  const finalizationAttempted = useRef(false);

  async function load(message = "", previouslyUncertain = false) {
    setBusy("load");
    const status = await readExchangeRecordedStatus();
    if (status) {
      setConnection(status);
      if (status.status === "connected") clearFlow();
      setUncertain(previouslyUncertain && status.status !== "connected");
      setNotice(message || "État enregistré dans le CRM; aucune nouvelle vérification Microsoft n’a été effectuée.");
    } else {
      setConnection(null);
      setUncertain(previouslyUncertain);
      setNotice("L’état de la connexion est inconnu. Aucun nouvel essai de connexion n’a été lancé.");
    }
    setBusy(null);
  }

  async function connect() {
    if (operationPending.current || !connection?.configured || uncertain) return;
    operationPending.current = true;
    setBusy("connect");
    setNotice("Préparation de la connexion Microsoft…");
    let redirecting = false;
    try {
      const bytes = crypto.getRandomValues(new Uint8Array(32));
      const binder = btoa(String.fromCharCode(...bytes)).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/u, "");
      if (!writeFlow({ binder })) {
        setNotice("Cet onglet ne permet pas de conserver la protection de connexion. Autorise le stockage de session avant de continuer.");
        return;
      }
      const result = await exchangeRequest("connect", { binder });
      if (!result.ok) {
        if (!result.ambiguous) clearFlow();
        setUncertain(result.ambiguous);
        setNotice(actionError(result));
        return;
      }
      const { flowId, authorizationUrl, expiresAt } = result.value;
      if (
        typeof flowId !== "string" || !FLOW_ID.test(flowId) ||
        !validMicrosoftAuthorizationUrl(authorizationUrl) ||
        typeof expiresAt !== "string" || !Number.isFinite(Date.parse(expiresAt)) ||
        !writeFlow({ flowId, binder })
      ) {
        setUncertain(true);
        setNotice("La préparation n’a pas fourni de confirmation utilisable. Vérifie l’état; aucun lien externe n’a été ouvert.");
        return;
      }
      setNotice("Ouverture de Microsoft pour autoriser uniquement la boîte prévue…");
      window.location.assign(authorizationUrl);
      redirecting = true;
    } catch {
      setUncertain(true);
      setNotice("La connexion n’a pas pu être ouverte. Vérifie l’état avant de recommencer.");
    } finally {
      if (!redirecting) {
        operationPending.current = false;
        setBusy(null);
      }
    }
  }

  async function finalize(flow: Required<BrowserFlow>) {
    if (operationPending.current) return;
    operationPending.current = true;
    setBusy("finalize");
    setNotice("Vérification du retour Microsoft et enregistrement de la connexion…");
    // Keep only the CSRF binder while the outcome is unknown. Consuming flowId
    // before POST prevents reload/StrictMode from redeeming the code twice.
    if (!writeFlow({ binder: flow.binder })) {
      setUncertain(true);
      setNotice("Impossible de protéger cette finalisation contre un nouvel essai. Aucun code n’a été envoyé; vérifie l’état.");
      operationPending.current = false;
      setBusy(null);
      return;
    }
    const result = await exchangeRequest("finalize", { flowId: flow.flowId, binder: flow.binder });
    const status = result.ok ? parseExchangeConnectionStatus(result.value) : null;
    if (status) {
      clearFlow();
      setConnection(status);
      setUncertain(false);
      setNotice(status.status === "connected"
        ? "La connexion est enregistrée. Aucun courriel n’a été envoyé, supprimé ou synchronisé."
        : "Microsoft demande une nouvelle connexion. Aucun courriel n’a été envoyé.");
    } else if (!result.ok && !result.ambiguous) {
      clearFlow();
      setUncertain(false);
      setNotice(actionError(result));
    } else {
      setUncertain(true);
      setNotice("Le résultat de la finalisation est incertain. Vérifie l’état; le code ne sera pas renvoyé automatiquement.");
    }
    operationPending.current = false;
    setBusy(null);
  }

  async function perform(action: "check" | "disconnect") {
    if (operationPending.current) return;
    operationPending.current = true;
    setBusy(action);
    setNotice(action === "check" ? "Vérification de l’état Microsoft…" : "Déconnexion du CRM…");
    const result = await exchangeRequest(action);
    const status = result.ok ? parseExchangeConnectionStatus(result.value) : null;
    if (status) {
      setConnection(status);
      setUncertain(false);
      clearFlow();
      setNotice(action === "disconnect"
        ? status.status === "disconnected"
          ? "Le CRM est déconnecté. Les courriels Microsoft et les données du CRM sont conservés."
          : "La déconnexion n’est pas confirmée. Consulte l’état de la connexion avant de continuer."
        : status.status === "connected"
          ? "La connexion Microsoft est confirmée. L’envoi et la synchronisation restent désactivés."
          : status.status === "reauth_required"
            ? "Microsoft demande une nouvelle autorisation. Tu peux relancer la connexion."
            : "Aucune connexion active. Tu peux commencer une nouvelle connexion.");
    } else {
      // A failed provider check can already have persisted reauth_required.
      // Read that state once; never retry the POST or reuse an authorization code.
      const recordedStatus = action === "check" ? await readExchangeRecordedStatus() : null;
      if (action === "check") setConnection(recordedStatus);
      const recovered = recordedStatus !== null && recordedStatus.status !== "connected";
      setUncertain(!recovered);
      if (recovered) clearFlow();
      setNotice(action !== "check"
        ? "L’état n’a pas pu être confirmé. Aucun code d’autorisation ni envoi de courriel n’a été rejoué."
        : recordedStatus?.status === "reauth_required"
          ? "Le CRM indique qu’une nouvelle autorisation est requise. La vérification Microsoft n’a pas été relancée."
          : recordedStatus?.status === "disconnected"
            ? "État enregistré : aucune connexion active. La vérification Microsoft n’a pas été relancée."
            : recordedStatus?.status === "connected"
              ? "La connexion reste enregistrée dans le CRM, mais la vérification Microsoft n’a pas abouti. Aucun nouvel essai automatique."
              : "L’état de la connexion est inconnu : sa lecture a aussi échoué. Aucun nouvel essai Microsoft automatique.");
    }
    operationPending.current = false;
    setBusy(null);
  }

  useEffect(() => {
    if (initialized.current) return;
    initialized.current = true;
    const url = new URL(window.location.href);
    const completion = exchangeCompletionRequested(url);
    if (completion) {
      // Consume the browser marker before any asynchronous work. It carries no
      // provider code, state, token, or error detail.
      url.searchParams.delete("complete");
      window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
    }
    const flow = readFlow();
    if (completion && flow?.flowId && !finalizationAttempted.current) {
      finalizationAttempted.current = true;
      void finalize(flow as Required<BrowserFlow>);
      return;
    }
    const message = completion
      ? "Ce retour ne correspond pas à une connexion commencée dans cet onglet. Aucun code n’a été rejoué."
      : flow && !flow.flowId
        ? "Une tentative a déjà été effectuée. Vérifie l’état avant de commencer une nouvelle connexion."
        : "";
    void load(message, Boolean(flow && !flow.flowId));
  }, []);

  return (
    <main className="mobile-authorization-screen">
      <section className="mobile-authorization-panel" aria-labelledby="exchange-connection-title" aria-busy={busy !== null}>
        <p className="mobile-authorization-kicker">27PM CRM · Connexion courriel</p>
        <h1 id="exchange-connection-title">Microsoft Exchange</h1>
        <p>
          Cette étape autorise le CRM à accéder à la seule boîte d’Alexis. Elle
          n’active ni l’envoi, ni la suppression, ni la synchronisation des courriels.
        </p>
        <dl className="settings-facts">
          <div><dt>Boîte principale</dt><dd>alexis@27pm.org</dd></div>
          <div><dt>Alias de la même boîte</dt><dd>bonjour@27pm.org · admin@27pm.org</dd></div>
          <div><dt>État enregistré</dt><dd>{connection ? statusLabel(connection.status) : "Inconnu"}</dd></div>
          <div><dt>Courriels dans le CRM</dt><dd>Envoi et synchronisation désactivés</dd></div>
          {connection?.updatedAt ? <div><dt>Dernière mise à jour</dt><dd>{formatDate(connection.updatedAt)}</dd></div> : null}
        </dl>
        <p>
          La réception actuelle et les MX ne changent pas. Les droits Microsoft
          comprennent techniquement la lecture, la modification et la suppression,
          ainsi que l’envoi; aucun message ne sera supprimé par ce raccordement.
        </p>
        <p>
          Déconnecter le CRM bloque son utilisation de la boîte. Cela ne révoque
          pas automatiquement le consentement Microsoft, qui peut être retiré
          séparément dans le compte Microsoft.
        </p>
        {connection?.cleanupPending ? (
          <p className="settings-warning" role="status">
            Nettoyage en attente : un justificatif chiffré doit encore être retiré
            du stockage privé. L’état de connexion indiqué ci-dessus reste distinct
            de ce nettoyage.
          </p>
        ) : null}
        {connection?.configured === false ? (
          <p className="settings-warning">La configuration sécurisée du serveur n’est pas encore complète. Aucune connexion ne peut être lancée.</p>
        ) : null}
        {uncertain ? <p className="settings-warning">Vérifie d’abord l’état. Ne recommence pas la même autorisation.</p> : null}
        <div className="settings-section">
          {connection?.status !== "connected" ? (
            <button className="primary-action" disabled={busy !== null || !connection?.configured || uncertain} onClick={() => void connect()} type="button">
              {busy === "connect" ? "Préparation…" : connection?.status === "reauth_required" ? "Reconnecter Microsoft" : "Connecter Microsoft"}
            </button>
          ) : null}
          <button className="secondary-action" disabled={busy !== null} onClick={() => void perform("check")} type="button">
            {busy === "check" ? "Vérification…" : "Vérifier l’état"}
          </button>
          {connection?.status === "connected" || connection?.status === "reauth_required" ? (
            <button className="secondary-action" disabled={busy !== null} onClick={() => void perform("disconnect")} type="button">
              {busy === "disconnect" ? "Déconnexion…" : "Déconnecter le CRM"}
            </button>
          ) : null}
        </div>
        <p className="mobile-authorization-status" role="status" aria-live="polite">{notice}</p>
        <Link className="secondary-action" href="/">Retour au CRM</Link>
      </section>
    </main>
  );
}

export function parseExchangeConnectionStatus(value: unknown): ExchangeConnectionStatus | null {
  if (!isObject(value) || typeof value.configured !== "boolean" || value.mailFlowEnabled !== false ||
      typeof value.status !== "string" || !["disconnected", "connected", "reauth_required"].includes(value.status) ||
      (value.cleanupPending !== undefined && typeof value.cleanupPending !== "boolean") ||
      (value.updatedAt !== undefined && value.updatedAt !== null &&
        (typeof value.updatedAt !== "string" || !Number.isFinite(Date.parse(value.updatedAt))))) return null;
  return {
    configured: value.configured,
    status: value.status as ExchangeConnectionStatus["status"],
    mailFlowEnabled: false,
    ...(value.cleanupPending === undefined ? {} : { cleanupPending: value.cleanupPending as boolean }),
    ...(value.updatedAt === undefined ? {} : { updatedAt: value.updatedAt as string | null }),
  };
}

export function parseExchangeBrowserFlow(value: string | null): BrowserFlow | null {
  if (!value || value.length > 512) return null;
  try {
    const flow: unknown = JSON.parse(value);
    if (!isObject(flow) || Object.keys(flow).some((key) => key !== "binder" && key !== "flowId") ||
        typeof flow.binder !== "string" || !BINDER.test(flow.binder) ||
        (flow.flowId !== undefined && (typeof flow.flowId !== "string" || !FLOW_ID.test(flow.flowId)))) return null;
    return { binder: flow.binder, ...(typeof flow.flowId === "string" ? { flowId: flow.flowId } : {}) };
  } catch { return null; }
}

export function exchangeCompletionRequested(url: URL): boolean {
  const marker = url.searchParams.getAll("complete");
  return marker.length === 1 && marker[0] === "1";
}

export function validMicrosoftAuthorizationUrl(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 8192) return false;
  try {
    const url = new URL(value);
    return url.origin === "https://login.microsoftonline.com" && !url.username && !url.password && !url.hash &&
      /^\/[0-9a-f-]{36}\/oauth2\/v2\.0\/authorize$/iu.test(url.pathname) &&
      ["response_type", "response_mode", "code_challenge_method"].every((name) => url.searchParams.getAll(name).length === 1) &&
      url.searchParams.get("response_type") === "code" &&
      url.searchParams.get("response_mode") === "form_post" &&
      url.searchParams.get("code_challenge_method") === "S256";
  } catch { return false; }
}

/** Read-only recovery: the stored status is not fresh proof from Microsoft. */
export async function readExchangeRecordedStatus(): Promise<ExchangeConnectionStatus | null> {
  const result = await exchangeRequest();
  return result.ok ? parseExchangeConnectionStatus(result.value) : null;
}

async function exchangeRequest(action?: Action, input: Record<string, string> = {}): Promise<ApiResult> {
  try {
    const response = await fetch(ENDPOINT, {
      method: action ? "POST" : "GET",
      ...(action ? { headers: { "content-type": "application/json" }, body: JSON.stringify({ action, ...input }) } : {}),
      credentials: "same-origin", cache: "no-store", redirect: "error", signal: AbortSignal.timeout(30_000),
    });
    const payload: unknown = await response.json();
    if (!response.ok) {
      return { ok: false, ambiguous: response.status >= 500, error: isObject(payload) && typeof payload.error === "string" ? payload.error : "request_failed" };
    }
    if (!isObject(payload)) return { ok: false, ambiguous: true, error: "response_invalid" };
    return { ok: true, value: payload };
  } catch { return { ok: false, ambiguous: true, error: "network_unconfirmed" }; }
}

function readFlow(): BrowserFlow | null {
  try { return parseExchangeBrowserFlow(window.sessionStorage.getItem(FLOW_STORAGE_KEY)); }
  catch { return null; }
}

function writeFlow(flow: BrowserFlow): boolean {
  try {
    window.sessionStorage.setItem(FLOW_STORAGE_KEY, JSON.stringify(flow));
    return true;
  } catch { return false; }
}

function clearFlow(): void {
  try { window.sessionStorage.removeItem(FLOW_STORAGE_KEY); }
  catch { /* No provider credential is stored in the browser. */ }
}

function actionError(result: { ambiguous: boolean; error: string }): string {
  if (result.ambiguous) return "La réponse du serveur n’est pas confirmée. Vérifie l’état avant toute nouvelle connexion.";
  if (result.error === "exchange_reauthentication_required") return "L’autorisation Microsoft a expiré ou a été refusée. Commence une nouvelle connexion.";
  return "La connexion n’a pas abouti. Aucun courriel n’a été envoyé. Vérifie l’état avant de recommencer.";
}

function statusLabel(status: ExchangeConnectionStatus["status"]): string {
  return { disconnected: "Déconnectée", connected: "Connectée", reauth_required: "Nouvelle autorisation requise" }[status];
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat("fr-CA", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
