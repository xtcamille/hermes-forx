import { useStore } from '@nanostores/react'
import { memo, type ReactNode, useCallback, useEffect, useMemo } from 'react'

import { useGatewayRequest } from '@/app/gateway/hooks/use-gateway-request'
import { Button } from '@/components/ui/button'
import { Codicon } from '@/components/ui/codicon'
import { Switch } from '@/components/ui/switch'
import { Tip } from '@/components/ui/tooltip'
import { $pluginRecords, type PluginRecord, setPluginEnabled } from '@/contrib/plugins-store'
import { discoverRuntimePlugins } from '@/contrib/runtime-loader'
import type { ProfileScope } from '@/hermes'
import { useI18n } from '@/i18n'
import { triggerHaptic } from '@/lib/haptics'
import { FolderOpen, Loader2, Monitor, Package, RefreshCw, Trash2 } from '@/lib/icons'
import { CATALOG_ORIGIN, CATALOG_PICKER_URL } from '@/lib/plugin-catalog'
import { cn } from '@/lib/utils'
import {
  $agentPluginBusy,
  $agentPlugins,
  $agentPluginsError,
  $agentPluginsStatus,
  type AgentPluginRow,
  type GatewayRequest,
  isDesktopRelevantPlugin,
  loadAgentPlugins,
  removeAgentPlugin,
  toggleAgentPlugin,
  updateAgentPlugin
} from '@/store/agent-plugins'
import { confirm } from '@/store/confirm'
import { notify, notifyError } from '@/store/notifications'
import { openCatalogPluginInstall } from '@/store/plugin-catalog-install'
import { openPluginInstallRequest } from '@/store/plugin-install-request'
import { $connection } from '@/store/session'

import { PanelEmpty } from '../../overlays/panel'
import { Pill } from '../../settings/primitives'
import { useDeepLinkHighlight } from '../../settings/use-deep-link-highlight'
import { EmbeddedCatalogPane } from '../embedded-catalog-pane'

import { mergePluginPackages, type PackageKind, type PluginPackage } from './plugin-packages'

// The REAL Plugin Catalog page (docs site) embedded as a one-click picker —
// the same pattern as the Skills tab's EmbeddedHubPicker. `?embed=picker`
// hides the docs chrome and adds "+ Add to this Agent" per card, which posts
//   { type: 'hermes-plugin-pick', name, repo, sha, subdir, tier, installCmd }
// to the parent window. We validate the origin and open the shared
// dual-target install modal (agent half → catalog-pinned install into the
// scoped profile; desktop half → this app), so unified packages install both
// halves in one flow. URLs live in `@/lib/plugin-catalog` so the
// `hermes://plugin/install?catalog=` deep link resolves against the same feed.

interface PluginPickMessage {
  installCmd?: string
  name?: string
  repo?: string
  sha?: string
  subdir?: string
  tier?: string
  type?: string
}

/** Deep-link anchor for a package row (`/capabilities?tab=plugins&plugin=<key>`).
 *  Accepts the agent key, the agent name, or the desktop record id. */
export const pluginElementId = (target: string) => `plugin-${target}`

/** Derive the bare profile name a `plugins.manage` call should target. */
function profileParam(scope: ProfileScope): null | string {
  if (!scope) {
    return null
  }

  return typeof scope === 'string' ? scope : (scope.profile ?? null)
}

function reveal(file: string) {
  void window.hermesDesktop?.revealPath?.(file)?.catch(() => undefined)
}

async function revealPluginsDir() {
  try {
    // Electron owns the app-level plugin root — deriving it from the backend's
    // hermes_home breaks against a remote backend (#66899).
    const dir = await window.hermesDesktop?.desktopPluginsRoot?.()

    if (!dir) {
      notifyError('Desktop plugins are unavailable', 'Could not resolve the plugins folder')

      return
    }

    const result = await window.hermesDesktop?.openDir?.(dir)

    if (result && !result.ok) {
      notifyError(result.error ?? 'unknown error', 'Could not open the plugins folder')
    }
  } catch (err) {
    notifyError(err, 'Could not resolve the plugins folder')
  }
}

/** Copy any changed unified desktop halves into the app root FIRST, then
 *  rescan the root — a concurrent scan would read the pre-copy state. */
async function rescanAll(requestGateway: GatewayRequest, scope: null | string) {
  await window.hermesDesktop?.reconcileDesktopPlugins?.().catch(() => undefined)
  await discoverRuntimePlugins()
  await loadAgentPlugins(requestGateway, scope)
}

/** Open the dual-target install modal pre-filled to install ONLY the agent
 *  half of a unified package into the scoped profile (the desktop half is
 *  already here). Provenance comes from the package marker Electron stamped
 *  when it copied the half out (catalog sidecar or git remote). */
function installAgentHalfHere(record: PluginRecord, profile: null | string) {
  const origin = record.packageOrigin

  if (!origin?.repo) {
    return
  }

  openPluginInstallRequest({
    catalogName: origin.catalogName,
    legacyHint: 'agent',
    profile,
    repo: origin.repo,
    sha: origin.sha
  })
}

function KindBadge({ kind }: { kind: PackageKind }) {
  const { t } = useI18n()
  const p = t.skills.plugins

  return (
    <span className="inline-flex items-center gap-1 rounded border border-(--ui-stroke-tertiary) px-1.5 py-px text-[0.65rem] text-(--ui-text-tertiary)">
      {kind !== 'desktop' && <Package aria-hidden className="size-3" />}
      {kind !== 'agent' && <Monitor aria-hidden className="size-3" />}
      {kind === 'both' ? p.kindBoth : kind === 'agent' ? p.kindAgent : p.kindDesktop}
    </span>
  )
}

/** Provenance pill: where the package came from. */
function ProvenancePill({ pkg }: { pkg: PluginPackage }) {
  const { t } = useI18n()
  const p = t.skills.plugins

  if (pkg.agent?.catalog_name) {
    return (
      <Tip label={p.catalogProvenance(pkg.agent.installed_sha?.slice(0, 8) ?? '')}>
        <span>
          <Pill>{pkg.agent.catalog_tier === 'official' ? p.tierOfficial : p.tierCommunity}</Pill>
        </span>
      </Tip>
    )
  }

  if (pkg.agent?.pinned_sha) {
    return (
      <Tip label={p.pinnedProvenance(pkg.agent.pinned_sha.slice(0, 8))}>
        <span>
          <Pill>
            <span className="font-mono">{p.pinnedBadge(pkg.agent.pinned_sha.slice(0, 8))}</span>
          </Pill>
        </span>
      </Tip>
    )
  }

  if (pkg.agent) {
    return <Pill>{pkg.agent.source}</Pill>
  }

  if (pkg.desktop) {
    return <Pill>{t.settings.plugins.kinds[pkg.desktop.kind]}</Pill>
  }

  return null
}

/** Column widths shared by the header and every row so the two control
 *  columns line up down the page like a table. */
const HALF_COL = 'flex w-36 shrink-0 items-center gap-1.5'

/** One control cell; `label` is the accessible name for screen readers only
 *  (the visible column label lives once, in the header). */
function HalfCell({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div aria-label={label} className={HALF_COL} role="cell">
      {children}
    </div>
  )
}

function Dash() {
  return (
    <span aria-hidden className="w-9 text-center text-(--ui-text-quaternary)">
      —
    </span>
  )
}

function PackageRow({
  pkg,
  scope,
  scopeLabel,
  busy,
  onAgentToggle,
  onAgentUpdate,
  onRemove
}: {
  pkg: PluginPackage
  scope: null | string
  scopeLabel: string
  busy: boolean
  onAgentToggle: (row: AgentPluginRow, enable: boolean) => void
  onAgentUpdate: (row: AgentPluginRow) => void
  onRemove: (pkg: PluginPackage) => void
}) {
  const { t } = useI18n()
  const p = t.skills.plugins
  const d = t.settings.plugins
  const desktop = pkg.desktop
  const agent = pkg.agent
  const desktopOn = desktop ? desktop.status !== 'disabled' : false
  const agentOn = agent?.status === 'enabled'
  const agentToggleable = Boolean(agent?.key)
  const canRemove = Boolean((agent && agent.source !== 'bundled') || (desktop && desktop.kind !== 'bundled'))
  // Electron's desktop-half reconcile only walks THIS machine's homes, so a
  // package installed on a remote backend can never materialize here (#114079).
  const remoteBackend = useStore($connection)?.mode === 'remote'

  return (
    <div
      className="flex items-center gap-3 border-b border-(--ui-stroke-tertiary) px-3 py-2.5 last:border-b-0"
      data-testid={`plugin-row-${pkg.key}`}
      id={pluginElementId(agent?.key ?? agent?.name ?? desktop?.id ?? pkg.key)}
      role="row"
    >
      <div className="flex min-w-0 flex-1 items-start gap-2" role="cell">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2 text-[length:var(--conversation-text-font-size)] font-medium text-foreground">
            <span>{pkg.name}</span>
            {agent?.version && <span className="text-(--ui-text-quaternary)">v{agent.version}</span>}
            <KindBadge kind={pkg.kind} />
            <ProvenancePill pkg={pkg} />
            {agent?.portable && <Pill>{p.portableBadge}</Pill>}
            {desktop?.status === 'error' && <Pill tone="primary">{d.failed}</Pill>}
          </div>
          {(desktop?.status === 'error' ? desktop.error : pkg.description) && (
            <div
              className={cn(
                'mt-0.5 text-[length:var(--conversation-caption-font-size)] break-words',
                desktop?.status === 'error' ? 'text-(--ui-danger,#f87171)' : 'text-(--ui-text-tertiary)'
              )}
            >
              {desktop?.status === 'error' ? desktop.error : pkg.description}
            </div>
          )}
        </div>
        {/* Fixed slot so the switch column stays straight whether or not
            this row has a folder to reveal (bundled plugins have none). */}
        <span className="flex h-7 min-w-7 shrink-0 items-center justify-center gap-0.5">
          {desktop?.file && (
            <Tip label={d.reveal}>
              <Button onClick={() => reveal(desktop.file!)} size="icon" variant="ghost">
                <Codicon name="folder-opened" size="0.85rem" />
              </Button>
            </Tip>
          )}
          {canRemove && (
            <Tip label={p.removePlugin}>
              <Button
                aria-label={`${p.removePlugin}: ${pkg.name}`}
                disabled={busy}
                onClick={() => onRemove(pkg)}
                size="icon"
                variant="ghost"
              >
                <Trash2 className="size-3.5 text-(--ui-text-tertiary) hover:text-(--ui-danger,#f87171)" />
              </Button>
            </Tip>
          )}
        </span>
      </div>

      {/* The two halves. Desktop is app-level and reads the same whichever
          profile is selected; Agent follows the selector. A half the package
          lacks shows a dash; a half it has but which is missing on this side
          shows the install affordance. */}
      <HalfCell label={p.halfDesktop}>
        {desktop ? (
          <Switch
            aria-label={`${p.halfDesktop}: ${pkg.name}`}
            checked={desktopOn}
            onCheckedChange={on => {
              triggerHaptic('selection')
              void setPluginEnabled(desktop.id, on)
            }}
          />
        ) : pkg.desktopMissing ? (
          <Tip label={remoteBackend ? p.desktopHalfRemoteTip : p.desktopHalfPendingTip}>
            <span className="text-[0.65rem] text-(--ui-text-tertiary)">
              {remoteBackend ? p.desktopHalfRemote : p.desktopHalfPending}
            </span>
          </Tip>
        ) : (
          <Dash />
        )}
      </HalfCell>

      <HalfCell label={p.halfAgentIn(scopeLabel)}>
        {agent ? (
          <>
            {agent.update_available && (
              <Button
                className="h-5 px-1.5 text-[0.65rem]"
                disabled={busy}
                onClick={() => onAgentUpdate(agent)}
                size="xs"
                variant="outline"
              >
                {p.updateToPin(agent.catalog_version ?? agent.catalog_sha?.slice(0, 8) ?? '')}
              </Button>
            )}
            {busy && <Loader2 className="size-3.5 animate-spin text-(--ui-text-tertiary)" />}
            {agentToggleable ? (
              <Switch
                aria-label={`${p.halfAgent}: ${pkg.name}`}
                checked={agentOn}
                disabled={busy}
                onCheckedChange={on => onAgentToggle(agent, on)}
              />
            ) : (
              <Tip label={p.legacyBackend}>
                <span>
                  <Switch aria-label={`${p.halfAgent}: ${pkg.name}`} checked={agentOn} disabled />
                </span>
              </Tip>
            )}
          </>
        ) : pkg.agentMissingInProfile && desktop ? (
          <Tip label={desktop.packageOrigin?.repo ? p.installAgentHereTip(scopeLabel) : p.installAgentHereNoOrigin}>
            <span>
              <Button
                className="h-5 px-1.5 text-[0.65rem]"
                disabled={!desktop.packageOrigin?.repo}
                onClick={() => installAgentHalfHere(desktop, scope)}
                size="xs"
                variant="outline"
              >
                {p.installAgentHere}
              </Button>
            </span>
          </Tip>
        ) : (
          <Dash />
        )}
      </HalfCell>
    </div>
  )
}

/** THE plugins surface: one row per package. Each row shows its Desktop half
 *  (this app — the same for every profile, gateway, or machine) and its Agent
 *  half (the selected profile's backend). Discovery sits underneath: the live
 *  catalog picker plus Install from Git for anything not in the catalog. */
export const PluginsTab = memo(function PluginsTab({
  profile,
  scopeSelector,
  scopeLabel
}: {
  profile: ProfileScope
  /** The Capabilities profile selector; rendered in the Agent column header so
   *  it visibly governs only that column. */
  scopeSelector?: ReactNode
  /** Display name of the selected profile for the Agent column label. */
  scopeLabel?: string
}) {
  const { t } = useI18n()
  const p = t.skills.plugins
  const d = t.settings.plugins
  const { requestGateway } = useGatewayRequest()

  const desktopRecords = useStore($pluginRecords)
  const agentRows = useStore($agentPlugins)
  const status = useStore($agentPluginsStatus)
  const error = useStore($agentPluginsError)
  const busyKey = useStore($agentPluginBusy)

  const scope = profileParam(profile)
  const label = scopeLabel ?? scope ?? t.skills.plugins.defaultProfile

  useEffect(() => {
    void loadAgentPlugins(requestGateway, scope)
  }, [requestGateway, scope])

  const packages = useMemo(
    () => mergePluginPackages(Object.values(desktopRecords), agentRows.filter(isDesktopRelevantPlugin)),
    [agentRows, desktopRecords]
  )

  useDeepLinkHighlight({ param: 'plugin', ready: () => true, elementId: pluginElementId })

  const onCatalogMessage = useCallback(
    (event: MessageEvent) => {
      if (event.origin !== CATALOG_ORIGIN) {
        return
      }

      const data = event.data as null | PluginPickMessage

      if (!data || data.type !== 'hermes-plugin-pick' || !data.name || !data.repo) {
        return
      }

      openCatalogPluginInstall(
        {
          name: String(data.name),
          repo: String(data.repo),
          sha: data.sha ? String(data.sha) : undefined,
          subdir: data.subdir ? String(data.subdir) : undefined
        },
        scope
      )
    },
    [scope]
  )

  const agentBusy = (row: AgentPluginRow) => busyKey === (row.key ?? row.name) || busyKey === row.name

  const handleRemove = async (pkg: PluginPackage) => {
    const confirmed = await confirm({
      confirmLabel: p.removePlugin,
      description: p.removeConfirmDesc,
      destructive: true,
      title: p.removeConfirmTitle(pkg.name)
    })

    if (!confirmed) {
      return
    }

    const name = pkg.agent?.name ?? pkg.desktop?.packageName ?? pkg.name
    const ok = await removeAgentPlugin(requestGateway, name, p.removeFailed(pkg.name), scope)

    if (ok) {
      notify({ kind: 'success', message: p.removeSuccess(pkg.name) })
      void rescanAll(requestGateway, scope)
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="min-h-32 flex-1 overflow-y-auto">
        {/* Header: what the two columns mean, and the controls that act on
            the whole page (install, folder, rescan). */}
        <div className="flex flex-wrap items-start justify-between gap-3 px-3 pt-3 pb-2">
          <p className="min-w-0 flex-1 text-[length:var(--conversation-caption-font-size)] text-(--ui-text-tertiary)">
            {p.pageBlurb}
          </p>
          <div className="flex shrink-0 items-center gap-1">
            <Button
              onClick={() => openPluginInstallRequest({ profile: scope, repo: '' })}
              size="sm"
              type="button"
              variant="secondary"
            >
              {d.installModal.installFromGit}
            </Button>
            <Tip label={d.openFolder}>
              <Button
                aria-label={d.openFolder}
                onClick={() => void revealPluginsDir()}
                size="icon"
                type="button"
                variant="ghost"
              >
                <FolderOpen className="size-3.5" />
              </Button>
            </Tip>
            <Tip label={d.rescan}>
              <Button
                aria-label={d.rescan}
                onClick={() => {
                  triggerHaptic('selection')
                  void rescanAll(requestGateway, scope)
                }}
                size="icon"
                type="button"
                variant="ghost"
              >
                <RefreshCw className="size-3.5" />
              </Button>
            </Tip>
          </div>
        </div>

        {status === 'error' ? (
          <PanelEmpty
            action={
              <Button onClick={() => void loadAgentPlugins(requestGateway, scope)} size="sm">
                {t.skills.refresh}
              </Button>
            }
            description={error ?? undefined}
            icon="error"
            title={p.loadFailed}
          />
        ) : packages.length === 0 && status === 'ready' ? (
          <p className="px-3 py-3 text-[length:var(--conversation-caption-font-size)] text-(--ui-text-tertiary)">
            {p.emptyAll} {p.emptyHint}
          </p>
        ) : (
          <div className="flex flex-col" role="table">
            {/* Column header: the visible labels for the two control columns,
                aligned with the cells below. The profile selector sits INSIDE
                the Agent header so it visibly governs only that column. */}
            <div
              className="flex items-center gap-3 border-y border-(--ui-stroke-tertiary) bg-(--ui-bg-quinary) px-3 py-1.5 text-[0.68rem] text-(--ui-text-tertiary)"
              role="row"
            >
              <div className="min-w-0 flex-1" role="columnheader" />
              <div className={HALF_COL} role="columnheader">
                <Monitor aria-hidden className="size-3.5 shrink-0" />
                <Tip label={p.halfDesktopHint}>
                  <span className="font-medium">{p.halfDesktop}</span>
                </Tip>
              </div>
              <div className={HALF_COL} role="columnheader">
                <Package aria-hidden className="size-3.5 shrink-0" />
                {scopeSelector ?? <span className="truncate font-medium">{p.halfAgentIn(label)}</span>}
              </div>
            </div>
            {packages.map(pkg => (
              <PackageRow
                busy={pkg.agent ? agentBusy(pkg.agent) : busyKey === (pkg.desktop?.packageName ?? pkg.name)}
                key={pkg.key}
                onAgentToggle={(row, enable) => {
                  if (!row.key) {
                    return
                  }

                  void toggleAgentPlugin(requestGateway, row.key, enable, p.toggleFailed(row.name), scope)
                }}
                onAgentUpdate={row => {
                  void updateAgentPlugin(requestGateway, row.name, p.updateFailed(row.name), scope).then(applied => {
                    if (applied) {
                      notify({ kind: 'success', message: p.updated(row.name) })
                      void rescanAll(requestGateway, scope)
                    }
                  })
                }}
                onRemove={handleRemove}
                pkg={pkg}
                scope={scope}
                scopeLabel={label}
              />
            ))}
          </div>
        )}
      </div>

      <EmbeddedCatalogPane
        browseLabel={p.catalogBrowse}
        hideLabel={p.catalogHide}
        hint={p.catalogHint}
        onMessage={onCatalogMessage}
        paneId="capabilities-plugin-catalog"
        src={CATALOG_PICKER_URL}
        title={p.catalogTitle}
      />
    </div>
  )
})
