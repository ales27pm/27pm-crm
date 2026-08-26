"use client";

import { useMemo, useState } from "react";
import type { Deal, PipelineStage } from "../crm-types";
import { Icon } from "./icons";

const columns: Array<{ stage: PipelineStage; label: string }> = [
  { stage: "nouveau", label: "Nouveau" },
  { stage: "qualifie", label: "Qualifié" },
  { stage: "proposition", label: "Proposition" },
  { stage: "production", label: "En production" },
  { stage: "gagne", label: "Gagné" },
];

type PipelineViewProps = {
  deals: Deal[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onMove: (id: string, stage: PipelineStage) => void;
};

export function PipelineView({ deals, selectedId, onSelect, onMove }: PipelineViewProps) {
  const [draggedId, setDraggedId] = useState<string | null>(null);
  const [dragTarget, setDragTarget] = useState<PipelineStage | null>(null);
  const [filter, setFilter] = useState<"all" | "follow-up">("all");
  const [sort, setSort] = useState<"action" | "name">("action");
  const [search, setSearch] = useState("");

  const visibleDeals = useMemo(() => {
    const query = search.trim().toLocaleLowerCase("fr-CA");
    return deals
      .filter((deal) => filter === "all" || Boolean(deal.nextAction.trim()))
      .filter((deal) => {
        if (!query) return true;
        return [deal.title, deal.contactName, deal.organization, deal.projectType].some(
          (value) => value.toLocaleLowerCase("fr-CA").includes(query),
        );
      })
      .toSorted((left, right) => {
        const leftValue = sort === "name" ? left.title : left.nextAction;
        const rightValue = sort === "name" ? right.title : right.nextAction;
        return leftValue.localeCompare(rightValue, "fr-CA");
      });
  }, [deals, filter, search, sort]);

  return (
    <section className="pipeline-view" aria-label="Pipeline des projets">
      <p className="sr-only" id="pipeline-keyboard-help">
        Appuyez sur Entrée pour ouvrir un dossier. Utilisez Alt et les flèches gauche ou droite pour le déplacer.
      </p>
      <div className="pipeline-toolbar">
        <label>
          <span className="sr-only">Filtrer les projets</span>
          <select
            value={filter}
            onChange={(event) => setFilter(event.target.value as "all" | "follow-up")}
          >
            <option value="all">Tous les projets</option>
            <option value="follow-up">Avec prochaine action</option>
          </select>
          <Icon name="chevron" />
        </label>
        <label>
          <span className="sr-only">Trier les projets</span>
          <select
            value={sort}
            onChange={(event) => setSort(event.target.value as "action" | "name")}
          >
            <option value="action">Prochaine action</option>
            <option value="name">Nom du projet</option>
          </select>
          <Icon name="chevron" />
        </label>
        <label className="search-field pipeline-search">
          <span className="sr-only">Rechercher dans le pipeline</span>
          <Icon name="search" />
          <input
            type="search"
            placeholder="Rechercher"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
          <kbd>⌘K</kbd>
        </label>
      </div>

      <div className="pipeline-board">
        {columns.map((column) => {
          const stageDeals = visibleDeals.filter((deal) => deal.stage === column.stage);
          return (
            <section
              className="pipeline-column"
              data-drag-target={dragTarget === column.stage || undefined}
              key={column.stage}
              aria-labelledby={`stage-${column.stage}`}
              onDragOver={(event) => {
                event.preventDefault();
                setDragTarget(column.stage);
              }}
              onDragLeave={() => setDragTarget(null)}
              onDrop={(event) => {
                event.preventDefault();
                if (draggedId) onMove(draggedId, column.stage);
                setDraggedId(null);
                setDragTarget(null);
              }}
            >
              <header>
                <h2 id={`stage-${column.stage}`}>{column.label}</h2>
                <span aria-label={`${stageDeals.length} dossiers`}>{stageDeals.length}</span>
              </header>
              <div className="pipeline-stack">
                {stageDeals.map((deal) => (
                  <article
                    className="deal-card"
                    data-selected={selectedId === deal.id || undefined}
                    key={deal.id}
                    draggable
                    role="button"
                    tabIndex={0}
                    aria-pressed={selectedId === deal.id}
                    aria-describedby="pipeline-keyboard-help"
                    onClick={() => onSelect(deal.id)}
                    onDragStart={() => setDraggedId(deal.id)}
                    onDragEnd={() => {
                      setDraggedId(null);
                      setDragTarget(null);
                    }}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        onSelect(deal.id);
                        return;
                      }
                      const index = columns.findIndex((item) => item.stage === deal.stage);
                      if (event.altKey && event.key === "ArrowRight" && columns[index + 1]) {
                        event.preventDefault();
                        onMove(deal.id, columns[index + 1].stage);
                      }
                      if (event.altKey && event.key === "ArrowLeft" && columns[index - 1]) {
                        event.preventDefault();
                        onMove(deal.id, columns[index - 1].stage);
                      }
                    }}
                  >
                    <div className="deal-card__title">
                      <Icon name="drag" />
                      <div>
                        <h3>{deal.title}</h3>
                        <p>{deal.contactName}</p>
                        <span>{deal.projectType}</span>
                      </div>
                    </div>
                    <dl>
                      <div><dt><Icon name="globe" /> Source</dt><dd>{deal.source}</dd></div>
                      <div><dt><Icon name="calendar" /> Prochaine action</dt><dd>{deal.nextAction}</dd></div>
                    </dl>
                  </article>
                ))}
              </div>
            </section>
          );
        })}
      </div>
    </section>
  );
}
