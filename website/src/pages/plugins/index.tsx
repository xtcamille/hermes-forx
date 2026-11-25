import React, { useState, useMemo, useCallback, useRef, useEffect } from "react";
import Link from "@docusaurus/Link";
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

interface PluginCapabilities {
  providesTools?: string[];
  providesHooks?: string[];
  providesMiddleware?: string[];
  requiresEnv?: string[];
}

interface CatalogPlugin {
  name: string;
  description: string;
  repo: string;
  sha: string;
  shaShort: string;
  tier: string;
  category: string;
  maintainer: string;
  subdir?: string;
  requiresHermes?: string;
  platforms?: string[];
  capabilities?: PluginCapabilities;
  docsUrl?: string;
  /** Human label for the pin ("1.4.0"); cosmetic, shown beside the sha. */
  version?: string;
  /** Card banner image (GitHub-hosted https URL enforced by the extractor). */
  image?: string;
  installCommand: string;
  /** GitHub stargazers at the last daily probe; null when the repo is not on GitHub or unprobed. */
  stars?: number | null;
  /** Lowercase pre-joined haystack for the search filter (built at load). */
  _search?: string;
}

interface CatalogMeta {
  generatedAt?: string;
  total?: number;
  byTier?: Record<string, number>;
  byCategory?: Record<string, number>;
  removedCount?: number;
  starsFetchedAt?: string | null;
}

// Docs section describing the PR-based submission workflow.
const SUBMIT_PLUGIN_URL = "/user-guide/features/plugin-catalog#submitting-a-plugin-to-the-catalog";

/** Deep link into the Desktop app's Install Plugin dialog, catalog mode: the app
 *  resolves the reviewed pin itself, so the page never hands it a repo URL. */
function desktopInstallLink(name: string): string {
  return `hermes://plugin/install?catalog=${encodeURIComponent(name)}`;
}

const TIER_CONFIG: Record<
  string,
  { label: string; color: string; icon: string }
> = {
  official: {
    label: "Official",
    color: "#2997ff",
    icon: "\u{2713}",
  },
  community: {
    label: "Community",
    color: "#94a3b8",
    icon: "\u{2756}",
  },
};

const TIER_ORDER = ["all", "official", "community"];

// Browse taxonomy. Order here is the order of the category filter and of the
// grouped sections; keep it in sync with CATALOG_CATEGORIES in
// hermes_cli/plugin_catalog.py and website/scripts/extract-plugins.py.
const CATEGORY_CONFIG: Record<string, { label: string; icon: string; blurb: string }> = {
  desktop: { label: "Desktop", icon: "\u{1F5A5}\u{FE0F}", blurb: "Panes, tabs and views for ForX Desktop" },
  memory: { label: "Memory", icon: "\u{1F9E0}", blurb: "Memory providers and context engines" },
  platform: { label: "Platforms", icon: "\u{1F4AC}", blurb: "Messaging and channel adapters" },
  web: { label: "Web & Browser", icon: "\u{1F310}", blurb: "Search backends, extraction and browser control" },
  tools: { label: "Tools", icon: "\u{1F6E0}\u{FE0F}", blurb: "New tools the agent can call" },
  voice: { label: "Voice", icon: "\u{1F399}\u{FE0F}", blurb: "Speech, TTS and realtime audio" },
  automation: { label: "Automation", icon: "\u{23F1}\u{FE0F}", blurb: "Hooks, wake triggers and session automation" },
  models: { label: "Models", icon: "\u{2728}", blurb: "Model and inference providers" },
  general: { label: "General", icon: "\u{1F4E6}", blurb: "Plugins that span several areas" },
};
const CATEGORY_ORDER = Object.keys(CATEGORY_CONFIG);

function formatRelativeTime(iso?: string): string | null {
  if (!iso) return null;
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return null;
  const diffMs = Date.now() - then;
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

function formatStars(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k` : String(n);
}

function PluginCard({
  plugin,
  query,
  expanded,
  onToggle,
  onPick,
  onCategoryClick,
}: {
  plugin: CatalogPlugin;
  query: string;
  expanded: boolean;
  onToggle: () => void;
  /** Picker embed mode: render "+ Add to this Agent" and call this. */
  onPick?: (plugin: CatalogPlugin) => void;
  onCategoryClick?: (category: string) => void;
}) {
  const tier = TIER_CONFIG[plugin.tier] || TIER_CONFIG.community;
  const category = CATEGORY_CONFIG[plugin.category] || CATEGORY_CONFIG.general;
  const caps = plugin.capabilities || {};
  const toolCount = caps.providesTools?.length || 0;
  const hookCount = caps.providesHooks?.length || 0;
  const middlewareCount = caps.providesMiddleware?.length || 0;
  const pinUrl = `${plugin.repo.replace(/\.git$/, "").replace(/\/$/, "")}/tree/${plugin.sha}`;

  return (
    <div
      className={`${catalogStyles.card} ${expanded ? catalogStyles.cardExpanded : ""}`}
      onClick={onToggle}
    >
      {plugin.image && (
        <img
          className={styles.cardImage}
          src={plugin.image}
          alt=""
          loading="lazy"
          decoding="async"
          referrerPolicy="no-referrer"
          onError={(e) => { e.currentTarget.style.display = "none"; }}
        />
      )}

      <div className={catalogStyles.cardInner}>
        <div className={catalogStyles.cardTop}>
          <span aria-hidden="true" className={catalogStyles.cardIcon}>{category.icon}</span>
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
                {highlightMatch(plugin.name, query)}
              </button>
            </h3>
            <span
              className={catalogStyles.badge}
              style={{ "--catalog-badge-accent": tier.color } as React.CSSProperties}
            >
              {tier.icon} {tier.label}
            </span>
            {plugin.version && (
              <span className={catalogStyles.badge} title={`Version ${plugin.version} at ${plugin.sha}`}>
                v{plugin.version.replace(/^v/i, "")}
              </span>
            )}
            {typeof plugin.stars === "number" && (
              <a
                className={`${catalogStyles.badge} ${styles.starPill}`}
                href={`${plugin.repo.replace(/\.git$/, "").replace(/\/$/, "")}/stargazers`}
                target="_blank"
                rel="noopener noreferrer"
                onClick={(e) => e.stopPropagation()}
                title={`${plugin.stars.toLocaleString()} GitHub stars`}
              >
                {"\u2605"} {formatStars(plugin.stars)}
              </a>
            )}
          </div>
        </div>

        <p className={`${catalogStyles.cardDesc} ${expanded ? catalogStyles.cardDescFull : ""}`}>
          {highlightMatch(plugin.description || "No description available.", query)}
        </p>

        <div className={catalogStyles.cardMeta}>
          <button
            className={catalogStyles.categoryChip}
            onClick={(e) => {
              e.stopPropagation();
              onCategoryClick?.(plugin.category);
            }}
            title={`Filter by ${category.label}`}
          >
            {category.label}
          </button>
          {toolCount > 0 && (
            <span className={catalogStyles.platformPill}>
              {toolCount} tool{toolCount === 1 ? "" : "s"}
            </span>
          )}
          {hookCount > 0 && (
            <span className={catalogStyles.platformPill}>
              {hookCount} hook{hookCount === 1 ? "" : "s"}
            </span>
          )}
          {middlewareCount > 0 && (
            <span className={catalogStyles.platformPill}>
              {middlewareCount} middleware
            </span>
          )}
          {caps.requiresEnv?.map((v) => (
            <code key={v} className={styles.envChip}>
              {v}
            </code>
          ))}
          <CatalogPlatforms platforms={plugin.platforms} />
        </div>

        {onPick ? (
          <button
            className={catalogStyles.pickBtn}
            onClick={(e) => {
              e.stopPropagation();
              onPick(plugin);
            }}
          >
            + Add to this Agent
          </button>
        ) : (
          <a
            className={catalogStyles.pickBtn}
            href={desktopInstallLink(plugin.name)}
            title="Opens the Install Plugin dialog in ForX Desktop at the reviewed version. No app? Use the install command below."
            onClick={(e) => e.stopPropagation()}
          >
            Open in ForX Desktop
          </a>
        )}

        {expanded && (
          <div className={catalogStyles.cardDetail}>
            {plugin.maintainer && (
              <div className={styles.metaRow}>
                <span className={styles.metaLabel}>Maintainer</span>
                <span className={styles.metaValue}>{plugin.maintainer}</span>
              </div>
            )}
            {plugin.requiresHermes && (
              <div className={styles.metaRow}>
                <span className={styles.metaLabel}>Requires</span>
                <span className={styles.metaValue}>
                  <code>hermes {plugin.requiresHermes}</code>
                </span>
              </div>
            )}
            <div className={styles.metaRow}>
              <span className={styles.metaLabel}>Pinned</span>
              <span className={styles.metaValue}>
                <a
                  href={pinUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={(e) => e.stopPropagation()}
                  title={plugin.sha}
                >
                  <code>{plugin.version ? `${plugin.version} @ ${plugin.shaShort}` : plugin.shaShort}</code> ↗
                </a>
              </span>
            </div>
            {caps.providesTools?.length ? (
              <div className={styles.metaRow}>
                <span className={styles.metaLabel}>Tools</span>
                <span className={styles.chipList}>
                  {caps.providesTools.map((t) => (
                    <code key={t} className={styles.envChip}>
                      {t}
                    </code>
                  ))}
                </span>
              </div>
            ) : null}
            <CopyInstallCommand text={plugin.installCommand} />
            <div className={catalogStyles.cardLinks}>
              <a
                className={catalogStyles.secondaryButton}
                href={plugin.repo}
                target="_blank"
                rel="noopener noreferrer"
                onClick={(e) => e.stopPropagation()}
              >
                Repository ↗
              </a>
              {plugin.docsUrl ? (
                <a
                  className={catalogStyles.secondaryButton}
                  href={plugin.docsUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={(e) => e.stopPropagation()}
                >
                  Documentation ↗
                </a>
              ) : null}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function buildSearchHaystack(p: CatalogPlugin): string {
  return [
    p.name,
    p.description,
    p.maintainer,
    p.tier,
    p.category,
    CATEGORY_CONFIG[p.category]?.label,
    ...(p.capabilities?.providesTools || []),
    ...(p.capabilities?.providesHooks || []),
    ...(p.capabilities?.requiresEnv || []),
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

export default function PluginCatalogPage() {
  // Picker embed mode (?embed=picker): the page is iframed by a host app
  // (Hermes desktop's Capabilities > Plugins tab) as a one-click catalog
  // picker. Site chrome is hidden via CSS and every card gains an
  // "+ Add to this Agent" button that posts
  //   { type: 'hermes-plugin-pick', name, repo, sha, subdir, tier,
  //     installCmd }
  // to the parent window. The HOST performs the actual install through its
  // own gateway (plugins.manage, catalog_name=<name>) — this page never
  // installs anything; parents must validate event.origin before acting.
  const pickerMode = useCatalogPickerMode();

  const pickPlugin = useCallback((plugin: CatalogPlugin) => {
    if (typeof window === "undefined" || window.parent === window) return;
    window.parent.postMessage(
      {
        type: "hermes-plugin-pick",
        name: plugin.name,
        repo: plugin.repo,
        sha: plugin.sha,
        subdir: plugin.subdir || "",
        tier: plugin.tier,
        installCmd: plugin.installCommand || `forx plugins install ${plugin.name}`,
      },
      "*"
    );
  }, []);

  const [data, setData] = useState<{ plugins: CatalogPlugin[]; meta: CatalogMeta } | null>(
    null,
  );
  const [loadError, setLoadError] = useState<string | null>(null);

  const [search, setSearch] = useState("");
  const [tierFilter, setTierFilter] = useState("all");
  const [categoryFilter, setCategoryFilter] = useState("all");
  const [expandedCard, setExpandedCard] = useState<string | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const pluginsUrl = useBaseUrl("/api/plugins.json");
  const metaUrl = useBaseUrl("/api/plugins-meta.json");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [pl, mt] = await Promise.all([
          fetch(pluginsUrl).then((r) => {
            if (!r.ok) throw new Error(`plugins.json HTTP ${r.status}`);
            return r.json();
          }),
          fetch(metaUrl).then((r) => (r.ok ? r.json() : {})).catch(() => ({})),
        ]);
        if (cancelled) return;
        const arr = Array.isArray(pl) ? (pl as CatalogPlugin[]) : [];
        for (const p of arr) p._search = buildSearchHaystack(p);
        setData({ plugins: arr, meta: mt || {} });
      } catch (err) {
        if (cancelled) return;
        setLoadError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

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

  const allPlugins: CatalogPlugin[] = data?.plugins ?? [];
  const meta: CatalogMeta = data?.meta ?? {};

  const filtered = useMemo(() => {
    const q = search.toLowerCase().trim();
    return allPlugins.filter((p) => {
      if (tierFilter !== "all" && p.tier !== tierFilter) return false;
      if (categoryFilter !== "all" && p.category !== categoryFilter) return false;
      if (q) return (p._search || "").includes(q);
      return true;
    });
  }, [search, tierFilter, categoryFilter, allPlugins]);

  // Browse mode (no search, no category picked): render one section per
  // category so Memory, Desktop, Platforms… read as distinct shelves rather
  // than one undifferentiated wall. Filtering or searching flattens to a grid.
  const grouped = useMemo(() => {
    if (search.trim() || categoryFilter !== "all") return null;
    const buckets = new Map<string, CatalogPlugin[]>();
    for (const p of filtered) {
      const key = CATEGORY_CONFIG[p.category] ? p.category : "general";
      (buckets.get(key) ?? buckets.set(key, []).get(key)!).push(p);
    }
    return CATEGORY_ORDER.filter((c) => buckets.has(c)).map((c) => [c, buckets.get(c)!] as const);
  }, [filtered, search, categoryFilter]);

  const categoryCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const p of allPlugins) {
      if (tierFilter !== "all" && p.tier !== tierFilter) continue;
      const key = CATEGORY_CONFIG[p.category] ? p.category : "general";
      counts[key] = (counts[key] || 0) + 1;
    }
    return counts;
  }, [allPlugins, tierFilter]);

  useEffect(() => {
    setExpandedCard(null);
  }, [search, tierFilter, categoryFilter]);

  const clearAll = useCallback(() => {
    setSearch("");
    setTierFilter("all");
    setCategoryFilter("all");
  }, []);

  const pickCategory = useCallback((c: string) => {
    setCategoryFilter((cur) => (cur === c ? "all" : c));
    setSearch("");
  }, []);

  const catalogEmpty = data !== null && allPlugins.length === 0;

  const renderCard = (plugin: CatalogPlugin) => {
    const key = `${plugin.tier}-${plugin.name}`;
    return (
      <PluginCard
        key={key}
        plugin={plugin}
        query={search}
        expanded={expandedCard === key}
        onToggle={() => setExpandedCard(expandedCard === key ? null : key)}
        onPick={pickerMode ? pickPlugin : undefined}
        onCategoryClick={pickCategory}
      />
    );
  };

  return (
    <CatalogPage
      path="/plugins"
      pickerMode={pickerMode}
      description="Give ForX new powers: reviewed plugins you can install in one click"
      intro="Browse reviewed plugins for memory, voice, messaging, browsing, and ForX Desktop."
      meta={!catalogEmpty && (
        <>
          {meta.generatedAt && (
            <span>
              {allPlugins.length} plugins across {Object.keys(categoryCounts).length} categories
              {" · "}Updated{" "}
              <span title={meta.starsFetchedAt ? `Catalog ${meta.generatedAt}; popularity ranking as of ${meta.starsFetchedAt}` : meta.generatedAt}>
                {formatRelativeTime(meta.generatedAt) || "recently"}
              </span>
            </span>
          )}
          <Link to={SUBMIT_PLUGIN_URL}>Submit a plugin →</Link>
        </>
      )}
    >
      <CatalogToolbar
        pickerMode={pickerMode}
        search={search}
        searchLabel="Search plugins"
        searchRef={searchRef}
        onSearchChange={setSearch}
        filters={[
          {
            label: "Plugin tier",
            value: tierFilter,
            onChange: setTierFilter,
            options: TIER_ORDER.map((tier) => ({
              value: tier,
              label: tier === "all" ? "All tiers" : TIER_CONFIG[tier].label,
              count: tier === "all" ? allPlugins.length : allPlugins.filter((p) => p.tier === tier).length,
            })),
          },
          {
            label: "Plugin category",
            value: categoryFilter,
            onChange: (category) => {
              if (category === "all") setCategoryFilter("all");
              else pickCategory(category);
            },
            options: [
              { value: "all", label: "All categories" },
              ...CATEGORY_ORDER.filter((category) => categoryCounts[category] || category === categoryFilter)
                .map((category) => ({
                  value: category,
                  label: CATEGORY_CONFIG[category].label,
                  count: categoryCounts[category] ?? 0,
                })),
            ],
          },
        ]}
      />

      <main className={catalogStyles.content}>
        {!data && !loadError ? (
          <CatalogStatus loading title="Loading the catalog…" />
        ) : loadError ? (
          <CatalogStatus title="Couldn’t load the catalog" description={loadError} />
        ) : catalogEmpty ? (
          <CatalogStatus
            title="The catalog is just getting started"
            description="Entries are reviewed and pinned to an exact commit. Submissions are open."
          >
            <div className={catalogStyles.emptyActions}>
              <Link className={catalogStyles.pickBtn} to={SUBMIT_PLUGIN_URL}>
                How to submit a plugin
              </Link>
              <Link className={catalogStyles.secondaryButton} to="/user-guide/features/plugin-catalog">
                Read the catalog docs
              </Link>
            </div>
          </CatalogStatus>
        ) : filtered.length > 0 && grouped ? (
          grouped.map(([cat, plugins]) => {
            const conf = CATEGORY_CONFIG[cat];
            return (
              <section key={cat} className={styles.categorySection} aria-labelledby={`cat-${cat}`}>
                <header className={styles.categoryHeader}>
                  <h2 id={`cat-${cat}`} className={styles.categoryTitle}>
                    <span aria-hidden="true">{conf.icon}</span> {conf.label}
                    <span className={catalogStyles.platformPill}>{plugins.length}</span>
                  </h2>
                  <p className={styles.categoryBlurb}>{conf.blurb}</p>
                  <button className={styles.categoryViewAll} type="button" onClick={() => pickCategory(cat)}>
                    View only {conf.label} →
                  </button>
                </header>
                <div className={catalogStyles.grid}>
                  {plugins.map(renderCard)}
                </div>
              </section>
            );
          })
        ) : filtered.length > 0 ? (
          <>
            <div className={catalogStyles.resultsBar} role="status">
              {categoryFilter !== "all" && CATEGORY_CONFIG[categoryFilter] && (
                <span>
                  <span aria-hidden="true">{CATEGORY_CONFIG[categoryFilter].icon}</span>{" "}
                  <strong>{CATEGORY_CONFIG[categoryFilter].label}</strong>
                  <span style={{ opacity: 0.7 }}> · {CATEGORY_CONFIG[categoryFilter].blurb}</span>
                </span>
              )}
              {search.trim() && (
                <span>
                  Results for <strong>“{search.trim()}”</strong>
                </span>
              )}
              <span>
                {filtered.length} plugin{filtered.length === 1 ? "" : "s"}
              </span>
              <button type="button" onClick={clearAll}>
                Clear filters
              </button>
            </div>
            <div className={catalogStyles.grid}>{filtered.map(renderCard)}</div>
          </>
        ) : (
          <CatalogStatus
            title="No plugins found"
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
