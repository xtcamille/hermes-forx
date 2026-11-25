import React, { useEffect, useState } from "react";
import Link from "@docusaurus/Link";
import { useLocation } from "@docusaurus/router";
import useBaseUrl from "@docusaurus/useBaseUrl";
import useIsBrowser from "@docusaurus/useIsBrowser";
import Layout from "@theme/Layout";
import styles from "./styles.module.css";

const catalogs = {
  "/skills": { title: "Skills Hub", label: "Skills" },
  "/plugins": { title: "Plugin Catalog", label: "Plugins" },
};

export function useCatalogPickerMode() {
  const isBrowser = useIsBrowser();
  const { search } = useLocation();
  return isBrowser && new URLSearchParams(search).get("embed") === "picker";
}

function CatalogMark({ size }: { size: number }) {
  const src = useBaseUrl("/img/favicon.svg");
  return <img alt="ForX" className={styles.mark} src={src} width={size} height={size} />;
}

interface CatalogPageProps {
  path: keyof typeof catalogs;
  pickerMode: boolean;
  description: string;
  intro: React.ReactNode;
  meta?: React.ReactNode;
  children: React.ReactNode;
}

export function CatalogPage({ path, pickerMode, description, intro, meta, children }: CatalogPageProps) {
  const { title } = catalogs[path];
  return (
    <Layout title={`ForX ${title}`} description={description} noFooter={pickerMode}>
      <div className={pickerMode ? `${styles.page} ${styles.pickerMode}` : styles.page}>
        {!pickerMode && (
          <header className={styles.hero}>
            <div className={styles.heroTop}>
              <div className={styles.heroHeading}>
                <CatalogMark size={56} />
                <h1>{title}</h1>
              </div>
              <nav className={styles.crossNav} aria-label="Catalog pages">
                {Object.entries(catalogs).map(([catalogPath, catalog]) => (
                  <Link
                    key={catalogPath}
                    to={catalogPath}
                    aria-current={path === catalogPath ? "page" : undefined}
                  >
                    {catalog.label}
                  </Link>
                ))}
              </nav>
            </div>
            <p className={styles.heroIntro}>{intro}</p>
            {meta && <div className={styles.heroMeta}>{meta}</div>}
          </header>
        )}
        {children}
      </div>
    </Layout>
  );
}

interface CatalogFilter {
  label: string;
  value: string;
  options: readonly { value: string; label: string; count?: number }[];
  onChange: (value: string) => void;
}

interface CatalogToolbarProps {
  pickerMode: boolean;
  search: string;
  searchLabel: string;
  searchRef: React.RefObject<HTMLInputElement | null>;
  onSearchChange: (value: string) => void;
  filters: readonly CatalogFilter[];
}

export function CatalogToolbar({ pickerMode, search, searchLabel, searchRef, onSearchChange, filters }: CatalogToolbarProps) {
  useEffect(() => {
    const focusCatalogSearch = (event: KeyboardEvent) => {
      if (event.key !== "/" || event.altKey || event.ctrlKey || event.metaKey || event.isComposing) return;
      const target = event.composedPath()[0];
      if (target instanceof HTMLElement && (target.isContentEditable || target.matches("input, select, textarea"))) return;

      // Take the catalog shortcut before the site-wide documentation search.
      event.preventDefault();
      event.stopPropagation();
      searchRef.current?.focus();
    };
    window.addEventListener("keydown", focusCatalogSearch, true);
    return () => window.removeEventListener("keydown", focusCatalogSearch, true);
  }, [searchRef]);

  return (
    <div className={styles.toolbar}>
      <div className={styles.toolbarInner}>
        <div className={styles.searchRow}>
          {pickerMode && <CatalogMark size={34} />}
          <div className={styles.searchWrap}>
            <svg aria-hidden="true" className={styles.searchIcon} viewBox="0 0 20 20" fill="currentColor" width="18" height="18">
              <path
                fillRule="evenodd"
                d="M8 4a4 4 0 100 8 4 4 0 000-8zM2 8a6 6 0 1110.89 3.476l4.817 4.817a1 1 0 01-1.414 1.414l-4.816-4.816A6 6 0 012 8z"
                clipRule="evenodd"
              />
            </svg>
            <input
              ref={searchRef}
              type="search"
              aria-label={searchLabel}
              aria-keyshortcuts="/"
              placeholder={searchLabel}
              value={search}
              onChange={(event) => onSearchChange(event.target.value)}
              className={styles.searchInput}
            />
            {search && (
              <button
                type="button"
                aria-label="Clear search"
                className={styles.clearSearch}
                onClick={() => {
                  onSearchChange("");
                  searchRef.current?.focus();
                }}
              >
                ×
              </button>
            )}
          </div>
        </div>
        <div className={styles.filters}>
          {filters.map(({ label, value, options, onChange }) => (
            <select key={label} aria-label={label} value={value} onChange={(event) => onChange(event.target.value)}>
              {options.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}{option.count === undefined ? "" : ` (${option.count.toLocaleString()})`}
                </option>
              ))}
            </select>
          ))}
        </div>
      </div>
    </div>
  );
}

interface CatalogStatusProps {
  title: string;
  description?: React.ReactNode;
  loading?: boolean;
  children?: React.ReactNode;
}

export function CatalogStatus({ title, description, loading, children }: CatalogStatusProps) {
  return (
    <div className={styles.empty} role={loading ? "status" : undefined}>
      {loading && <div className={styles.loadingSpinner} />}
      <h2>{title}</h2>
      {description && <p>{description}</p>}
      {children}
    </div>
  );
}

const platformLabels: Record<string, string> = { linux: "Linux", macos: "macOS", windows: "Windows" };

export function CatalogPlatforms({ platforms }: { platforms?: readonly string[] }) {
  return platforms?.map((platform) => (
    <span key={platform} className={styles.platformPill}>
      {platformLabels[platform] ?? platform}
    </span>
  ));
}

export function highlightMatch(text: string, query: string): React.ReactNode {
  const search = query.trim();
  if (!search) return text;
  const index = text.toLowerCase().indexOf(search.toLowerCase());
  if (index === -1) return text;
  return (
    <>
      {text.slice(0, index)}
      <mark className={styles.highlight}>{text.slice(index, index + search.length)}</mark>
      {text.slice(index + search.length)}
    </>
  );
}

export function CopyInstallCommand({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className={styles.installHint}>
      <code>{text}</code>
      <button
        type="button"
        className={styles.copyBtn}
        aria-label={copied ? "Install command copied" : "Copy install command"}
        onClick={(event) => {
          event.stopPropagation();
          navigator.clipboard?.writeText(text).then(
            () => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            },
            () => {},
          );
        }}
      >
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}
