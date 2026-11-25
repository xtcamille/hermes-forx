import React, { useState, useMemo, useCallback, useRef, useEffect } from "react";
import useBaseUrl from "@docusaurus/useBaseUrl";
import {
  CatalogPage,
  CatalogPlatforms,
  CatalogStatus,
  CatalogToolbar,
  CopyInstallCommand,
  highlightMatch,
  useCatalogPickerMode,
} from "../../components/Catalog";
import catalogStyles from "../../components/Catalog/styles.module.css";
import styles from "./styles.module.css";

interface Skill {
  name: string;
  description: string;
  overview?: string;
  category: string;
  categoryLabel: string;
  source: string;
  tags: string[];
  platforms: string[];
  author: string;
  version: string;
  license?: string;
  envVars?: string[];
  commands?: string[];
  docsPath?: string;
  identifier?: string;
  installCmd?: string;
  /** Clickable URL to the skill's origin (repo / detail page). Synthesized
   *  in extract-skills.py for community skills that have no generated docs
   *  page, so the expanded card always has somewhere to send the user. */
  sourceUrl?: string;
  /** Lowercase pre-joined haystack used by the search filter.
   *  Built once at load time so per-keystroke filtering is a single
   *  `.includes()` per skill instead of array-join + toLowerCase on
   *  every render. Skipped on the wire — added in the loader. */
  _search?: string;
}

const allSkills: Skill[] = [];

interface IndexMeta {
  extractedAt?: string;
  indexGeneratedAt?: string;
  totalSkills?: number;
  externalSource?: string;
  bySource?: Record<string, number>;
}
const indexMeta: IndexMeta = {};

function formatRelativeTime(iso?: string): string | null {
  if (!iso) return null;
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return null;
  const now = Date.now();
  const diffMs = now - then;
  if (diffMs < 0) return "just now";
  const mins = Math.floor(diffMs / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} minute${mins === 1 ? "" : "s"} ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} day${days === 1 ? "" : "s"} ago`;
  const months = Math.floor(days / 30);
  return `${months} month${months === 1 ? "" : "s"} ago`;
}

const CATEGORY_ICONS: Record<string, string> = {
  apple: "\u{1F34E}",
  "autonomous-ai-agents": "\u{1F916}",
  blockchain: "\u{26D3}",
  communication: "\u{1F4AC}",
  creative: "\u{1F3A8}",
  "data-science": "\u{1F4CA}",
  devops: "\u{2699}",
  dogfood: "\u{1F436}",
  domain: "\u{1F310}",
  email: "\u{2709}",
  feeds: "\u{1F4E1}",
  gaming: "\u{1F3AE}",
  gifs: "\u{1F3AC}",
  github: "\u{1F4BB}",
  health: "\u{2764}",
  "inference-sh": "\u{26A1}",
  leisure: "\u{2615}",
  mcp: "\u{1F50C}",
  media: "\u{1F3B5}",
  migration: "\u{1F4E6}",
  mlops: "\u{1F9EA}",
  "note-taking": "\u{1F4DD}",
  productivity: "\u{2705}",
  "red-teaming": "\u{1F6E1}",
  research: "\u{1F50D}",
  security: "\u{1F512}",
  "smart-home": "\u{1F3E0}",
  "social-media": "\u{1F4F1}",
  "software-development": "\u{1F4BB}",
  translation: "\u{1F30D}",
  other: "\u{1F4E6}",
};

const SOURCE_CONFIG: Record<
  string,
  { label: string; color: string; icon: string }
> = {
  "built-in": {
    label: "Built-in",
    color: "#4ade80",
    icon: "\u{2713}",
  },
  optional: {
    label: "Optional",
    color: "#fbbf24",
    icon: "\u{2B50}",
  },
  Anthropic: {
    label: "Anthropic",
    color: "#d4845a",
    icon: "\u{25C6}",
  },
  LobeHub: {
    label: "LobeHub",
    color: "#60a5fa",
    icon: "\u{25CB}",
  },
  "skills.sh": {
    label: "skills.sh",
    color: "#34d399",
    icon: "\u{2734}",
  },
  ClawHub: {
    label: "ClawHub",
    color: "#f472b6",
    icon: "\u{2726}",
  },
  "browse.sh": {
    label: "browse.sh",
    color: "#22d3ee",
    icon: "\u{29BF}",
  },
  OpenAI: {
    label: "OpenAI",
    color: "#10b981",
    icon: "\u{2737}",
  },
  HuggingFace: {
    label: "HuggingFace",
    color: "#fbbf24",
    icon: "\u{1F917}",
  },
  NVIDIA: {
    label: "NVIDIA",
    color: "#76b900",
    icon: "\u{25B6}",
  },
  VoltAgent: {
    label: "VoltAgent",
    color: "#facc15",
    icon: "\u{26A1}",
  },
  GitHub: {
    label: "GitHub",
    color: "#94a3b8",
    icon: "\u{2756}",
  },
  "Well-Known": {
    label: "Well-Known",
    color: "#818cf8",
    icon: "\u{2756}",
  },
  gstack: {
    label: "gstack",
    color: "#fb923c",
    icon: "\u{2756}",
  },
  MiniMax: {
    label: "MiniMax",
    color: "#f87171",
    icon: "\u{2756}",
  },
};

const SOURCE_ORDER = [
  "all",
  "built-in",
  "optional",
  "Anthropic",
  "OpenAI",
  "HuggingFace",
  "NVIDIA",
  "skills.sh",
  "ClawHub",
  "browse.sh",
  "LobeHub",
  "VoltAgent",
  "Well-Known",
  "GitHub",
  "gstack",
  "MiniMax",
];

/** Deep link into the Desktop app's Install Skill action. */
function desktopSkillInstallLink(skill: Skill): string {
  const target = skill.identifier || skill.name;
  return `hermes://skill/install?name=${encodeURIComponent(skill.name)}&identifier=${encodeURIComponent(target)}`;
}

function SkillCard({
  skill,
  query,
  expanded,
  onToggle,
  onCategoryClick,
  onTagClick,
  onPick,
}: {
  skill: Skill;
  query: string;
  expanded: boolean;
  onToggle: () => void;
  onCategoryClick: (cat: string) => void;
  onTagClick: (tag: string) => void;
  /** Picker embed mode: render "+ Add to this Agent" and call this. */
  onPick?: (skill: Skill) => void;
}) {
  const src = SOURCE_CONFIG[skill.source] || SOURCE_CONFIG["optional"];
  const icon = CATEGORY_ICONS[skill.category] || "\u{1F4E6}";
  const installCmd = skill.installCmd || `forx skills install ${skill.name}`;

  return (
    <div
      className={`${catalogStyles.card} ${expanded ? catalogStyles.cardExpanded : ""}`}
      onClick={onToggle}
    >
      <div className={catalogStyles.cardInner}>
        <div className={catalogStyles.cardTop}>
          <span aria-hidden="true" className={catalogStyles.cardIcon}>{icon}</span>
          <div className={catalogStyles.cardTitleGroup}>
            <h3 className={catalogStyles.cardTitle}>
              <button
                type="button"
                aria-expanded={expanded}
                onClick={(event) => {
                  event.stopPropagation();
                  onToggle();
                }}
              >
                {highlightMatch(skill.name, query)}
              </button>
            </h3>
            <span
              className={catalogStyles.badge}
              style={{ "--catalog-badge-accent": src.color } as React.CSSProperties}
            >
              {src.icon} {src.label}
            </span>
          </div>
        </div>

        <p className={`${catalogStyles.cardDesc} ${expanded ? catalogStyles.cardDescFull : ""}`}>
          {highlightMatch(skill.description || "No description available.", query)}
        </p>

        <div className={catalogStyles.cardMeta}>
          <button
            className={catalogStyles.categoryChip}
            onClick={(e) => {
              e.stopPropagation();
              onCategoryClick(skill.category);
            }}
            title={`Filter by ${skill.categoryLabel}`}
          >
            {skill.categoryLabel || skill.category}
          </button>
          <CatalogPlatforms platforms={skill.platforms} />
        </div>

        {onPick ? (
          <button
            className={catalogStyles.pickBtn}
            onClick={(e) => {
              e.stopPropagation();
              onPick(skill);
            }}
          >
            + Add to this Agent
          </button>
        ) : (
          <a
            className={catalogStyles.pickBtn}
            href={desktopSkillInstallLink(skill)}
            title={`Opens the install dialog in ForX Desktop for ${skill.name}. No app? Use the install command below.`}
            onClick={(e) => e.stopPropagation()}
          >
            Open in ForX Desktop
          </a>
        )}

        {expanded && (
          <div className={catalogStyles.cardDetail}>
            {skill.overview && (
              <div className={styles.overviewBlock}>
                <span className={styles.detailLabel}>Overview</span>
                <p className={styles.overviewText}>{skill.overview}</p>
              </div>
            )}
            {(skill.envVars?.length || skill.commands?.length) ? (
              <div className={styles.prereqBlock}>
                <span className={styles.detailLabel}>Prerequisites</span>
                {skill.envVars?.length ? (
                  <div className={styles.prereqRow}>
                    <span className={styles.prereqKind}>env</span>
                    <span className={styles.prereqList}>
                      {skill.envVars.map((v) => (
                        <code key={v} className={styles.prereqItem}>{v}</code>
                      ))}
                    </span>
                  </div>
                ) : null}
                {skill.commands?.length ? (
                  <div className={styles.prereqRow}>
                    <span className={styles.prereqKind}>cmd</span>
                    <span className={styles.prereqList}>
                      {skill.commands.map((c) => (
                        <code key={c} className={styles.prereqItem}>{c}</code>
                      ))}
                    </span>
                  </div>
                ) : null}
              </div>
            ) : null}
            {skill.tags?.length > 0 && (
              <div className={styles.tagRow}>
                {skill.tags.map((tag) => (
                  <button
                    key={tag}
                    className={catalogStyles.categoryChip}
                    onClick={(e) => {
                      e.stopPropagation();
                      onTagClick(tag);
                    }}
                  >
                    {tag}
                  </button>
                ))}
              </div>
            )}
            {skill.author && (
              <div className={styles.authorRow}>
                <span className={styles.authorLabel}>Author</span>
                <span className={styles.authorValue}>{skill.author}</span>
              </div>
            )}
            {skill.version && (
              <div className={styles.authorRow}>
                <span className={styles.authorLabel}>Version</span>
                <span className={styles.authorValue}>{skill.version}</span>
              </div>
            )}
            {skill.license && (
              <div className={styles.authorRow}>
                <span className={styles.authorLabel}>License</span>
                <span className={styles.authorValue}>{skill.license}</span>
              </div>
            )}
            <CopyInstallCommand text={installCmd} />
            <div className={catalogStyles.cardLinks}>
              {skill.docsPath ? (
                <a
                  className={catalogStyles.secondaryButton}
                  href={`/docs/user-guide/skills/${skill.docsPath}`}
                  onClick={(e) => e.stopPropagation()}
                >
                  View full documentation →
                </a>
              ) : skill.sourceUrl ? (
                <a
                  className={catalogStyles.secondaryButton}
                  href={skill.sourceUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={(e) => e.stopPropagation()}
                >
                  View source ↗
                </a>
              ) : null}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

const PAGE_SIZE = 60;

function buildSearchHaystack(s: Skill): string {
  // Pre-compute the lowercase blob the search filter scans. Done once at
  // load time instead of per-keystroke per-skill. With 50k+ skills the
  // per-keystroke variant was unusably slow.
  return [
    s.name,
    s.description,
    s.overview,
    s.categoryLabel,
    s.author,
    ...(s.tags || []),
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

export default function SkillsDashboard() {
  // Picker embed mode (?embed=picker): the page is being iframed by a host
  // app (Hermes desktop's Bot Mode agent editor) as a skill PICKER. Site
  // chrome is hidden via a CSS class and every card gains an
  // "+ Add to this Agent" button that posts
  //   { type: 'hermes-skill-pick', name, identifier, installCmd, source }
  // to the parent window. The HOST performs the actual install through its
  // own gateway (skills.manage) — the page never installs anything, so
  // there is no origin to trust in this direction; parents must validate
  // event.origin themselves before acting on the message.
  const pickerMode = useCatalogPickerMode();

  const pickSkill = useCallback(
    (skill: Skill) => {
      if (typeof window === "undefined" || window.parent === window) return;
      window.parent.postMessage(
        {
          type: "hermes-skill-pick",
          name: skill.name,
          identifier: skill.identifier || skill.name,
          installCmd: skill.installCmd || `forx skills install ${skill.name}`,
          source: skill.source,
        },
        "*"
      );
    },
    []
  );

  // Lazy-loaded data. Was bundled into the JS chunk (~22 MB at 50k skills,
  // which made the initial page load unusable on mobile). Now fetched on
  // mount from the same CDN that serves the docs.
  const [data, setData] = useState<{ skills: Skill[]; meta: IndexMeta } | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [search, setSearch] = useState("");
  // Debounced copy of `search` — used by the filter. Without the debounce,
  // typing into the search box ran .filter() over the whole catalog on
  // every keystroke, which on a 50k-item list felt like the page had
  // hung. 150ms gives a snappy feel without lagging behind the user.
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [sourceFilter, setSourceFilter] = useState("all");
  const [categoryFilter, setCategoryFilter] = useState("all");
  const [expandedCard, setExpandedCard] = useState<string | null>(null);
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  const searchRef = useRef<HTMLInputElement>(null);
  const gridRef = useRef<HTMLElement>(null);

  const skillsUrl = useBaseUrl("/api/skills.json");
  const metaUrl = useBaseUrl("/api/skills-meta.json");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [sk, mt] = await Promise.all([
          fetch(skillsUrl).then((r) => {
            if (!r.ok) throw new Error(`skills.json HTTP ${r.status}`);
            return r.json();
          }),
          fetch(metaUrl).then((r) => (r.ok ? r.json() : {})).catch(() => ({})),
        ]);
        if (cancelled) return;
        const skillsArr = Array.isArray(sk) ? (sk as Skill[]) : [];
        // Stamp the precomputed search haystack onto each row.
        for (const s of skillsArr) s._search = buildSearchHaystack(s);
        setData({ skills: skillsArr, meta: mt || {} });
      } catch (err) {
        if (cancelled) return;
        setLoadError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Debounce the search input — 150ms feels instant while preventing the
  // filter from running on every individual keystroke.
  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search), 150);
    return () => clearTimeout(t);
  }, [search]);

  const allSkillsLocal = data?.skills ?? allSkills;
  const indexMetaLocal: IndexMeta = data?.meta ?? indexMeta;

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        searchRef.current?.blur();
        setExpandedCard(null);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  const sourceCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const skill of allSkillsLocal) {
      counts.set(skill.source, (counts.get(skill.source) ?? 0) + 1);
    }
    return counts;
  }, [allSkillsLocal]);
  const sources = SOURCE_ORDER.filter((source) => source === "all" || sourceCounts.has(source));

  const categoryEntries = useMemo(() => {
    const pool =
      sourceFilter === "all"
        ? allSkillsLocal
        : allSkillsLocal.filter((s) => s.source === sourceFilter);
    const map = new Map<string, { label: string; count: number }>();
    for (const s of pool) {
      const key = s.category || "uncategorized";
      const existing = map.get(key);
      if (existing) {
        existing.count++;
      } else {
        map.set(key, {
          label: s.categoryLabel || s.category || "Uncategorized",
          count: 1,
        });
      }
    }
    return Array.from(map.entries())
      .sort((a, b) => b[1].count - a[1].count)
      .map(([key, { label, count }]) => ({ key, label, count }));
  }, [sourceFilter, allSkillsLocal]);

  const filtered = useMemo(() => {
    const q = debouncedSearch.toLowerCase().trim();
    return allSkillsLocal.filter((s) => {
      if (sourceFilter !== "all" && s.source !== sourceFilter) return false;
      if (categoryFilter !== "all" && s.category !== categoryFilter) return false;
      if (q) {
        // _search is pre-built in the load effect — single .includes() per row.
        return (s._search || "").includes(q);
      }
      return true;
    });
  }, [debouncedSearch, sourceFilter, categoryFilter, allSkillsLocal]);

  useEffect(() => {
    setVisibleCount(PAGE_SIZE);
    setExpandedCard(null);
  }, [debouncedSearch, sourceFilter, categoryFilter]);

  const visible = filtered.slice(0, visibleCount);
  const hasMore = visibleCount < filtered.length;

  const handleSourceChange = useCallback(
    (src: string) => {
      setSourceFilter(src);
      setCategoryFilter("all");
    },
    []
  );

  const handleCategoryClick = useCallback((cat: string) => {
    setCategoryFilter(cat);
    gridRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, []);

  const handleTagClick = useCallback((tag: string) => {
    setSearch(tag);
    searchRef.current?.focus();
  }, []);

  const clearAll = useCallback(() => {
    setSearch("");
    setSourceFilter("all");
    setCategoryFilter("all");
  }, []);

  const updatedAt = indexMetaLocal.indexGeneratedAt || indexMetaLocal.extractedAt;

  return (
    <CatalogPage
      path="/skills"
      pickerMode={pickerMode}
      description="Browse all skills and capabilities available for ForX Agent"
      intro={data
        ? `Browse ${allSkillsLocal.length.toLocaleString()} skills across ${sources.length - 1} registries.`
        : "Browse skills from ForX and community registries."}
      meta={updatedAt ? (
        <span title={updatedAt}>Catalog refreshed {formatRelativeTime(updatedAt) || "recently"}</span>
      ) : undefined}
    >
      <CatalogToolbar
        pickerMode={pickerMode}
        search={search}
        searchLabel="Search skills"
        searchRef={searchRef}
        onSearchChange={setSearch}
        filters={[
          {
            label: "Skill source",
            value: sourceFilter,
            onChange: handleSourceChange,
            options: sources.map((source) => ({
              value: source,
              label: source === "all" ? "All sources" : SOURCE_CONFIG[source]?.label ?? source,
              count: source === "all" ? allSkillsLocal.length : sourceCounts.get(source),
            })),
          },
          {
            label: "Skill category",
            value: categoryFilter,
            onChange: setCategoryFilter,
            options: [
              { value: "all", label: "All categories" },
              ...categoryEntries.map(({ key, label, count }) => ({ value: key, label, count })),
            ],
          },
        ]}
      />

      <main className={catalogStyles.content} ref={gridRef}>
        {(search || sourceFilter !== "all" || categoryFilter !== "all") && (
          <div className={catalogStyles.resultsBar}>
            <span role="status">{filtered.length} result{filtered.length !== 1 ? "s" : ""}</span>
            <button type="button" onClick={clearAll}>Clear filters</button>
          </div>
        )}

        {!data && !loadError ? (
          <CatalogStatus loading title="Loading the catalog…" />
        ) : loadError ? (
          <CatalogStatus title="Couldn’t load the catalog" description={loadError} />
        ) : visible.length > 0 ? (
          <>
            <div className={catalogStyles.grid}>
              {visible.map((skill, i) => {
                const key = `${skill.source}-${skill.name}-${i}`;
                return (
                  <SkillCard
                    key={key}
                    skill={skill}
                    query={search}
                    expanded={expandedCard === key}
                    onToggle={() =>
                      setExpandedCard(expandedCard === key ? null : key)
                    }
                    onCategoryClick={handleCategoryClick}
                    onTagClick={handleTagClick}
                    onPick={pickerMode ? pickSkill : undefined}
                  />
                );
              })}
            </div>
            {hasMore && (
              <div className={styles.loadMoreWrap}>
                <button
                  className={catalogStyles.secondaryButton}
                  type="button"
                  onClick={() => setVisibleCount((v) => v + PAGE_SIZE)}
                >
                  Show more ({filtered.length - visibleCount} remaining)
                </button>
              </div>
            )}
          </>
        ) : (
          <CatalogStatus
            title="No skills found"
            description="Try a different search term or clear your filters."
          >
            <button className={catalogStyles.secondaryButton} type="button" onClick={clearAll}>
              Reset all filters
            </button>
          </CatalogStatus>
        )}
      </main>
    </CatalogPage>
  );
}
