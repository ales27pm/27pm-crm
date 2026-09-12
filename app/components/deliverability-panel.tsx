"use client";

import { useEffect, useState } from "react";
import type {
  DeliverabilitySegment,
  DeliverabilitySummary,
} from "@/lib/deliverability-metrics";
import type { ReputationMode } from "@/lib/deliverability-policy";

type WindowName = "24h" | "7d" | "30d";

type DeliverabilityResponse = {
  generatedAt: string;
  window: { name: WindowName; startsAt: string; endsAt: string };
  reputation: {
    mode: ReputationMode;
    rampDay: number | null;
    dailyCap: number | null;
    automaticAdvancement: false;
    trackingEnabled: false;
    bulkSendingAvailable: false;
  };
  summary: DeliverabilitySummary;
  completeness: {
    complete: boolean;
    messagesTruncated: boolean;
    eventsTruncated: boolean;
  };
  caveats: string[];
};

const WINDOWS: Array<{ value: WindowName; label: string }> = [
  { value: "24h", label: "24 h" },
  { value: "7d", label: "7 jours" },
  { value: "30d", label: "30 jours" },
];
const LOADING_STATUS = "Chargement de la télémétrie…";

export function DeliverabilityPanel() {
  const { data, selectWindow, status, windowName } = useDeliverabilityTelemetry();

  return (
    <section className="settings-section deliverability-panel" aria-labelledby="deliverability-title">
      <header className="deliverability-heading">
        <div>
          <h2 id="deliverability-title">Délivrabilité</h2>
          <p>
            Mesure du transport par fournisseur. Une remise SMTP ne prouve ni
            la boîte de réception, ni la lecture.
          </p>
        </div>
        <WindowSelector selected={windowName} onSelect={selectWindow} />
      </header>

      {status ? <p role="status">{status}</p> : null}
      {data ? <DeliverabilityResults data={data} /> : null}
    </section>
  );
}

function useDeliverabilityTelemetry() {
  const [windowName, setWindowName] = useState<WindowName>("30d");
  const [data, setData] = useState<DeliverabilityResponse | null>(null);
  const [status, setStatus] = useState(LOADING_STATUS);

  useEffect(() => {
    const controller = new AbortController();
    void fetchDeliverability(windowName, controller.signal)
      .then(async (response) => {
        if (!response.ok) throw new Error("deliverability_unavailable");
        return (await response.json()) as DeliverabilityResponse;
      })
      .then((result) => {
        setData(result);
        setStatus("");
      })
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === "AbortError") return;
        setData(null);
        setStatus("La télémétrie de délivrabilité est indisponible.");
      });
    return () => controller.abort();
  }, [windowName]);

  function selectWindow(nextWindow: WindowName) {
    if (windowName === nextWindow) return;
    setData(null);
    setStatus(LOADING_STATUS);
    setWindowName(nextWindow);
  }

  return { data, selectWindow, status, windowName };
}

function fetchDeliverability(windowName: WindowName, signal: AbortSignal) {
  const options: RequestInit = { signal, cache: "no-store" };
  switch (windowName) {
    case "24h":
      return fetch("/api/admin/deliverability?window=24h", options);
    case "7d":
      return fetch("/api/admin/deliverability?window=7d", options);
    case "30d":
      return fetch("/api/admin/deliverability?window=30d", options);
  }
}

function WindowSelector({
  selected,
  onSelect,
}: {
  selected: WindowName;
  onSelect: (windowName: WindowName) => void;
}) {
  return (
    <div className="deliverability-window" aria-label="Fenêtre d’analyse">
      {WINDOWS.map((windowOption) => (
        <button
          type="button"
          key={windowOption.value}
          aria-pressed={selected === windowOption.value}
          onClick={() => onSelect(windowOption.value)}
        >
          {windowOption.label}
        </button>
      ))}
    </div>
  );
}

function DeliverabilityResults({ data }: { data: DeliverabilityResponse }) {
  return (
    <>
      <MetricSummary segment={data.summary.overall} />
      <PolicyState reputation={data.reputation} />
      <ProviderTable segments={data.summary.providers} />
      <CompletenessNotice data={data} />
      <ul className="deliverability-caveats">
        {data.caveats.map((caveat) => <li key={caveat}>{caveat}</li>)}
      </ul>
    </>
  );
}

function MetricSummary({ segment }: { segment: DeliverabilitySegment }) {
  return (
    <dl className="deliverability-summary">
      <MetricFact label="Acceptés Mailgun" value={segment.counts.accepted} />
      <MetricFact label="Remises serveur" value={segment.counts.delivered} />
      <MetricFact label="Rebonds durs" value={segment.counts.hardBounced} />
      <MetricFact label="Plaintes" value={segment.counts.complained} />
      <MetricFact label="Blocages fournisseur" value={segment.counts.policyBlocked ?? 0} />
      <MetricFact label="Échecs temporaires" value={segment.counts.temporarilyFailed} />
    </dl>
  );
}

function PolicyState({ reputation }: { reputation: DeliverabilityResponse["reputation"] }) {
  return (
    <div className="deliverability-policy-state">
      <strong>{reputationModeLabel(reputation.mode)}</strong>
      <span>
        {reputation.dailyCap === null
          ? "Aucun plafond automatique"
          : `Plafond manuel : ${reputation.dailyCap}/jour`}
      </span>
      <span>Avancement automatique désactivé</span>
      <span>Tracking ouverture/clic désactivé</span>
    </div>
  );
}

function ProviderTable({ segments }: { segments: DeliverabilitySegment[] }) {
  return (
    <div className="deliverability-table-wrap">
      <table className="deliverability-table">
        <caption>Résultats par fournisseur de boîte aux lettres</caption>
        <thead><tr>
          <th scope="col">Fournisseur</th><th scope="col">Acceptés</th>
          <th scope="col">Remise</th><th scope="col">Rebond dur</th>
          <th scope="col">Plainte</th><th scope="col">Temp./politique</th>
          <th scope="col">Lecture</th>
        </tr></thead>
        <tbody>
          {segments.map((segment) => <ProviderRow key={segment.key} segment={segment} />)}
        </tbody>
      </table>
    </div>
  );
}

function CompletenessNotice({ data }: { data: DeliverabilityResponse }) {
  const volume = data.completeness.complete
    ? `${data.summary.dataQuality.messages} messages uniques · ${data.summary.dataQuality.events} événements normalisés.`
    : "Vue incomplète : la limite de sécurité de la requête a été atteinte. Utilisez les agrégats Mailgun pour une analyse exhaustive.";
  const tagCoverage = data.summary.dataQuality.tagSegmentsTruncated
    ? "Segments de tags plafonnés à 256; la vue par tag est partielle."
    : data.summary.dataQuality.messagesWithTagTruncation > 0
      ? `${data.summary.dataQuality.messagesWithTagTruncation} message(s) contenaient plus de 32 tags; la vue par tag est partielle.`
      : "";
  return (
    <p className="settings-warning">
      {volume} {tagCoverage} Les taux marqués « données insuffisantes » ne
      constituent jamais un feu vert réputationnel.
    </p>
  );
}

function MetricFact({ label, value }: { label: string; value: number }) {
  return <div><dt>{label}</dt><dd>{value.toLocaleString("fr-CA")}</dd></div>;
}

function ProviderRow({ segment }: { segment: DeliverabilitySegment }) {
  const evaluation = segment.evaluation.overall;
  return (
    <tr>
      <th scope="row">{segment.label}</th>
      <td>{segment.counts.accepted}</td>
      <td>{metricLabel(segment.metrics.delivery)}</td>
      <td>{metricLabel(segment.metrics.hardBounce)}</td>
      <td>{metricLabel(segment.metrics.complaint)}</td>
      <td>{segment.counts.temporarilyFailed}/{segment.counts.policyBlocked ?? 0}</td>
      <td><span className="deliverability-status" data-status={evaluation}>{statusLabel(evaluation)}</span></td>
    </tr>
  );
}

function metricLabel(metric: { numerator: number; denominator: number; percent: number | null }) {
  return metric.percent === null
    ? `${metric.numerator}/${metric.denominator} —`
    : `${metric.numerator}/${metric.denominator} · ${metric.percent.toLocaleString("fr-CA", { maximumFractionDigits: 2 })} %`;
}

function statusLabel(status: DeliverabilitySegment["evaluation"]["overall"]) {
  return {
    target: "Dans la cible",
    warning: "À surveiller",
    critical: "Action requise",
    insufficient_data: "Données insuffisantes",
  }[status];
}

function reputationModeLabel(mode: ReputationMode): string {
  return {
    normal: "Mode normal — envoi individuel",
    domain_ramp: "Montée progressive du domaine",
    recovery: "Récupération de réputation",
    dedicated_ip_warmup: "Warm-up d’une IP dédiée",
  }[mode];
}
