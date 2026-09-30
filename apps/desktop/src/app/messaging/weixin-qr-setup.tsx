import { useEffect, useMemo, useState } from 'react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { ErrorBanner } from '@/components/ui/error-state'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import {
  applyWeixinOnboarding,
  cancelWeixinOnboarding,
  getWeixinDependencies,
  getWeixinOnboardingStatus,
  installWeixinDependencies,
  type MessagingPlatformInfo,
  startWeixinOnboarding,
  updateWeixinConfig,
  type WeixinDependenciesStatus,
  type WeixinDmPolicy,
  type WeixinGroupPolicy,
  type WeixinOnboardingApplyResponse,
  type WeixinOnboardingStatusResponse
} from '@/hermes'
import { useI18n } from '@/i18n'
import { Check, Download, Loader2, QrCode, RefreshCw, Save, X } from '@/lib/icons'
import { isSubmitEnter } from '@/lib/ime'
import { cn } from '@/lib/utils'

import { CREDENTIAL_CONTROL_CLASS } from '../settings/credential-key-ui'

import { formatExpiry } from './telegram-qr-setup'

type Phase = 'applying' | 'connected' | 'idle' | 'scanned' | 'starting' | 'waiting'

const splitCsv = (raw: string | undefined): string[] =>
  (raw || '')
    .split(',')
    .map(item => item.trim())
    .filter(Boolean)

export function isTerminalWeixinOnboardingError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)

  return /\b(404|410)\b/.test(message) && /\b(expired|not found|gone)\b/i.test(message)
}

async function renderQr(payload: string): Promise<string> {
  const QRCode = await import('qrcode')

  return QRCode.toDataURL(payload, { errorCorrectionLevel: 'M', margin: 1, width: 224 })
}

export interface WeixinQrSetupProps {
  /** Called after the backend saved credentials/config and triggered a gateway restart. */
  onApplied: (result: WeixinOnboardingApplyResponse) => void
  platform: MessagingPlatformInfo
  /** Request-shaped profile scope (undefined → active profile). */
  scopeProfile: string | undefined
}

const DM_POLICY_OPTIONS: WeixinDmPolicy[] = ['pairing', 'allowlist', 'open', 'disabled']
const GROUP_POLICY_OPTIONS: WeixinGroupPolicy[] = ['disabled', 'allowlist', 'open']

export function WeixinQrSetup({ onApplied, platform, scopeProfile }: WeixinQrSetupProps) {
  const { t } = useI18n()
  const q = t.messaging.weixinQr
  const setupInfo = platform.weixin_setup

  const [deps, setDeps] = useState<null | WeixinDependenciesStatus>(setupInfo?.dependencies ?? null)
  const [installingDeps, setInstallingDeps] = useState(false)
  const [checkingDeps, setCheckingDeps] = useState(false)

  const [setup, setSetup] = useState<null | WeixinOnboardingStatusResponse>(null)
  const [qrDataUrl, setQrDataUrl] = useState('')
  const [phase, setPhase] = useState<Phase>('idle')
  const [detectedUserId, setDetectedUserId] = useState<null | string>(null)

  const [dmPolicy, setDmPolicy] = useState<WeixinDmPolicy>(setupInfo?.dm_policy ?? 'pairing')
  const [allowedIds, setAllowedIds] = useState<string[]>(() => splitCsv(setupInfo?.allowed_users))
  const [newAllowedId, setNewAllowedId] = useState('')

  const [groupPolicy, setGroupPolicy] = useState<WeixinGroupPolicy>(setupInfo?.group_policy ?? 'disabled')
  const [groupAllowedIds, setGroupAllowedIds] = useState<string[]>(() => splitCsv(setupInfo?.group_allowed_users))
  const [newGroupAllowedId, setNewGroupAllowedId] = useState('')

  const [setHomeChannel, setSetHomeChannel] = useState<boolean>(
    setupInfo ? setupInfo.home_channel_set || !platform.configured : true
  )

  const [error, setError] = useState('')
  const [tick, setTick] = useState(0)

  // Sync wizard defaults when platform payload refreshes while idle.
  useEffect(() => {
    if (phase !== 'idle' || !setupInfo) {
      return
    }

    setDeps(setupInfo.dependencies)
    setDmPolicy(setupInfo.dm_policy)
    setAllowedIds(splitCsv(setupInfo.allowed_users))
    setGroupPolicy(setupInfo.group_policy)
    setGroupAllowedIds(splitCsv(setupInfo.group_allowed_users))
    setSetHomeChannel(setupInfo.home_channel_set || !platform.configured)
  }, [phase, platform.configured, setupInfo])

  // Render QR code whenever qr_payload changes.
  useEffect(() => {
    const payload = setup?.qr_payload?.trim()

    if (!payload) {
      setQrDataUrl('')

      return
    }

    let cancelled = false

    void renderQr(payload)
      .then(url => {
        if (!cancelled) {
          setQrDataUrl(url)
        }
      })
      .catch(qrErr => {
        if (!cancelled) {
          setError(String(qrErr))
        }
      })

    return () => {
      cancelled = true
    }
  }, [setup?.qr_payload])

  // Poll onboarding session status while starting, waiting for scan, or scanned.
  useEffect(() => {
    if (!setup || (phase !== 'starting' && phase !== 'waiting' && phase !== 'scanned')) {
      return
    }

    let cancelled = false
    let timer: null | number = null

    const poll = async () => {
      try {
        const status = await getWeixinOnboardingStatus(setup.pairing_id, scopeProfile)

        if (cancelled) {
          return
        }

        setSetup(status)

        if (status.status === 'connected') {
          setPhase('connected')
          setError('')

          const ownerId = status.user_id?.trim() || null

          if (ownerId) {
            setDetectedUserId(ownerId)
            setAllowedIds(current => (current.includes(ownerId) ? current : [ownerId, ...current]))
          }

          return
        }

        if (status.status === 'error' || status.status === 'expired' || status.status === 'cancelled') {
          setSetup(null)
          setQrDataUrl('')
          setPhase('idle')
          setError(status.error || q.pairingExpired)

          return
        }

        if (status.status === 'scanned') {
          setPhase('scanned')
        } else if (status.status === 'waiting') {
          setPhase('waiting')
        }

        setError('')
        timer = window.setTimeout(() => void poll(), 1500)
      } catch (pollError) {
        if (cancelled) {
          return
        }

        const expiresAt = Date.parse(setup.expires_at)
        const expired = Number.isFinite(expiresAt) && Date.now() >= expiresAt

        if (isTerminalWeixinOnboardingError(pollError) || expired) {
          setSetup(null)
          setQrDataUrl('')
          setPhase('idle')
          setError(q.pairingExpired)

          return
        }

        setError(q.stillWaiting(String(pollError)))
        timer = window.setTimeout(() => void poll(), 2000)
      }
    }

    timer = window.setTimeout(() => void poll(), 1000)

    return () => {
      cancelled = true

      if (timer !== null) {
        window.clearTimeout(timer)
      }
    }
  }, [phase, q, scopeProfile, setup])

  // One-second tick for QR expiration countdown.
  useEffect(() => {
    if (!setup || (phase !== 'waiting' && phase !== 'scanned' && phase !== 'starting')) {
      return
    }

    const timer = window.setInterval(() => setTick(value => value + 1), 1000)

    return () => window.clearInterval(timer)
  }, [phase, setup])

  const expiresIn = useMemo(
    () => (setup ? formatExpiry(setup.expires_at) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [setup, tick]
  )

  const handleRecheckDeps = async () => {
    setCheckingDeps(true)
    setError('')

    try {
      const latest = await getWeixinDependencies(scopeProfile)
      setDeps(latest)
    } catch (err) {
      setError(String(err))
    } finally {
      setCheckingDeps(false)
    }
  }

  const handleInstallDeps = async () => {
    setInstallingDeps(true)
    setError('')

    try {
      const updated = await installWeixinDependencies(true, scopeProfile)
      setDeps(updated)
    } catch (err) {
      setError(String(err))
    } finally {
      setInstallingDeps(false)
    }
  }

  const startQr = async () => {
    setPhase('starting')
    setError('')
    setDetectedUserId(null)

    try {
      const result = await startWeixinOnboarding(
        {
          dm_policy: dmPolicy,
          allowed_users: allowedIds.join(','),
          group_policy: groupPolicy,
          group_allowed_users: groupAllowedIds.join(','),
          set_home_channel: setHomeChannel
        },
        scopeProfile
      )

      setSetup(result)
      setPhase(result.status === 'connected' ? 'connected' : result.qr_payload ? 'waiting' : 'starting')
    } catch (startError) {
      setPhase('idle')
      setError(String(startError))
    }
  }

  const cancelQr = async () => {
    if (setup) {
      try {
        await cancelWeixinOnboarding(setup.pairing_id, scopeProfile)
      } catch {
        // Local reset still proceeds if backend already cleaned up.
      }
    }

    setSetup(null)
    setQrDataUrl('')
    setPhase('idle')
    setDetectedUserId(null)
    setError('')
  }

  const addAllowedId = () => {
    const trimmed = newAllowedId.trim()

    if (!trimmed) {
      return
    }

    setError('')
    setAllowedIds(ids => (ids.includes(trimmed) ? ids : [...ids, trimmed]))
    setNewAllowedId('')
  }

  const addGroupAllowedId = () => {
    const trimmed = newGroupAllowedId.trim()

    if (!trimmed) {
      return
    }

    setError('')
    setGroupAllowedIds(ids => (ids.includes(trimmed) ? ids : [...ids, trimmed]))
    setNewGroupAllowedId('')
  }

  const validateWizard = (): boolean => {
    if (dmPolicy === 'allowlist' && allowedIds.length === 0) {
      setError(q.addAtLeastOneUser)

      return false
    }

    if (groupPolicy === 'allowlist' && groupAllowedIds.length === 0) {
      setError(q.addAtLeastOneGroup)

      return false
    }

    return true
  }

  const applyOnboarding = async () => {
    if (!setup || !validateWizard()) {
      return
    }

    setPhase('applying')
    setError('')

    try {
      const result = await applyWeixinOnboarding(
        setup.pairing_id,
        {
          dm_policy: dmPolicy,
          allowed_users: allowedIds.join(','),
          group_policy: groupPolicy,
          group_allowed_users: groupAllowedIds.join(','),
          set_home_channel: setHomeChannel
        },
        scopeProfile
      )

      setSetup(null)
      setQrDataUrl('')
      setPhase('idle')
      onApplied(result)
    } catch (applyError) {
      setPhase('connected')
      setError(String(applyError))
    }
  }

  const saveConfigOnly = async () => {
    if (!validateWizard()) {
      return
    }

    setPhase('applying')
    setError('')

    try {
      const result = await updateWeixinConfig(
        {
          dm_policy: dmPolicy,
          allowed_users: allowedIds.join(','),
          group_policy: groupPolicy,
          group_allowed_users: groupAllowedIds.join(','),
          set_home_channel: setHomeChannel,
          home_channel_id: detectedUserId || allowedIds[0] || setupInfo?.home_channel || undefined
        },
        scopeProfile
      )

      setPhase('idle')
      onApplied(result)
    } catch (saveError) {
      setPhase('idle')
      setError(String(saveError))
    }
  }

  const depsOk = deps ? deps.ok : true
  const missingReq = deps?.missing_required ?? []
  const missingOpt = deps?.missing_optional ?? []
  const hasAnyMissingDeps = missingReq.length > 0 || missingOpt.length > 0
  const showWizard = phase === 'connected' || phase === 'applying' || platform.configured

  return (
    <div className="grid gap-3 rounded-xl border border-(--ui-stroke-secondary) bg-(--ui-surface-secondary,transparent) p-3.5">
      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[length:var(--conversation-text-font-size)] font-medium">{q.title}</span>
            <Badge variant="success">{q.recommended}</Badge>
          </div>
          <p className="mt-1 text-[length:var(--conversation-caption-font-size)] leading-(--conversation-caption-line-height) text-(--ui-text-tertiary)">
            {q.subtitle}
          </p>
        </div>
      </div>

      {error && <ErrorBanner>{error}</ErrorBanner>}

      {/* Step 1: Dependency Check & One-Click Install */}
      <div className="rounded-lg border border-(--ui-stroke-secondary) bg-background/40 p-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs font-semibold">{q.step1DepsTitle}</span>
              <Badge variant={depsOk ? 'success' : 'destructive'}>
                {depsOk ? q.depsInstalledSuccess : q.step1DepsMissing(missingReq.join(', '))}
              </Badge>
            </div>
            {deps && (
              <div className="mt-2 flex flex-wrap items-center gap-1.5">
                {(['aiohttp', 'cryptography', 'certifi', 'pilk'] as const).map(pkg => {
                  const installed = deps.packages[pkg]

                  const tag =
                    pkg === 'pilk' ? q.pkgOptionalVoice : pkg === 'certifi' ? q.pkgOptionalTls : q.pkgRequired

                  return (
                    <span
                      className={cn(
                        'inline-flex items-center gap-1 rounded-md border px-2 py-0.5 font-mono text-[0.7rem]',
                        installed
                          ? 'border-primary/30 bg-primary/5 text-foreground'
                          : 'border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-300'
                      )}
                      key={pkg}
                    >
                      {installed ? <Check className="size-3 text-primary" /> : <X className="size-3" />}
                      {pkg}
                      <span className="text-[0.65rem] text-muted-foreground">({tag})</span>
                    </span>
                  )
                })}
              </div>
            )}
            {depsOk && missingOpt.length > 0 && (
              <p className="mt-1.5 text-xs text-muted-foreground">{q.step1OptionalMissing(missingOpt.join(', '))}</p>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {hasAnyMissingDeps && (
              <Button
                disabled={installingDeps}
                onClick={() => void handleInstallDeps()}
                size="sm"
                variant={depsOk ? 'secondary' : 'default'}
              >
                {installingDeps ? <Loader2 className="animate-spin" /> : <Download />}
                {installingDeps ? q.installingDeps : depsOk ? q.installAllDeps : q.installDeps}
              </Button>
            )}
            <Button
              disabled={checkingDeps || installingDeps}
              onClick={() => void handleRecheckDeps()}
              size="sm"
              variant="ghost"
            >
              <RefreshCw className={checkingDeps ? 'animate-spin' : undefined} />
              {q.recheckDeps}
            </Button>
          </div>
        </div>
      </div>

      {/* Step 2: QR Code Scan */}
      <div className="rounded-lg border border-(--ui-stroke-secondary) bg-background/40 p-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="min-w-0">
            <span className="text-xs font-semibold">{q.step2QrTitle}</span>
            {platform.configured && phase === 'idle' && (
              <p className="mt-1 text-xs text-muted-foreground">{q.replaceWarning}</p>
            )}
          </div>

          {(phase === 'idle' || phase === 'connected') && (
            <Button disabled={!depsOk} onClick={() => void startQr()} size="sm">
              <QrCode />
              {platform.configured || phase === 'connected' ? q.rescanQr : q.startQrScan}
            </Button>
          )}
          {phase === 'starting' && (
            <Button disabled size="sm">
              <Loader2 className="animate-spin" />
              {q.startingQr}
            </Button>
          )}
        </div>

        {(phase === 'starting' || phase === 'waiting' || phase === 'scanned') && (
          <div className="mt-3 grid gap-4 border-t border-(--ui-stroke-secondary) pt-3 lg:grid-cols-[minmax(0,1fr)_240px]">
            <div className="grid content-start gap-2.5">
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant={phase === 'scanned' ? 'success' : 'warn'}>
                  {phase === 'scanned' ? q.scannedConfirmHint : q.waitingForScan}
                </Badge>
                {setup && setup.refresh_count > 0 && (
                  <Badge variant="outline">{q.refreshCount(setup.refresh_count)}</Badge>
                )}
              </div>
              <p className="text-xs leading-5 text-muted-foreground">{q.scanHint}</p>
              <div>
                <Button onClick={() => void cancelQr()} size="sm" variant="ghost">
                  {t.common.cancel}
                </Button>
              </div>
            </div>

            <div className="flex flex-col items-center gap-2">
              {qrDataUrl ? (
                <img alt="WeChat iLink QR code" className="size-56 rounded-md bg-white p-2" src={qrDataUrl} />
              ) : (
                <div className="flex size-56 items-center justify-center rounded-md border border-(--ui-stroke-secondary) bg-muted/30">
                  <Loader2 className="size-6 animate-spin text-muted-foreground" />
                </div>
              )}
              {setup && (
                <Badge variant={expiresIn ? 'outline' : 'destructive'}>
                  {expiresIn ? q.expiresIn(expiresIn) : q.expired}
                </Badge>
              )}
            </div>
          </div>
        )}

        {phase === 'connected' && setup && (
          <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-(--ui-stroke-secondary) pt-3">
            <Badge variant="success">{q.connectedBadge}</Badge>
            {setup.account_id && (
              <span className="font-mono text-xs text-muted-foreground">{q.accountConnected(setup.account_id)}</span>
            )}
            {detectedUserId && <Badge variant="outline">{q.ownerDetected(detectedUserId)}</Badge>}
          </div>
        )}
      </div>

      {/* Step 3: Configuration Wizard */}
      {showWizard && (
        <div className="grid gap-3 rounded-lg border border-(--ui-stroke-secondary) bg-background/40 p-3">
          <div>
            <span className="text-xs font-semibold">{q.step3WizardTitle}</span>
            <p className="mt-0.5 text-xs text-muted-foreground">{q.step3WizardSubtitle}</p>
          </div>

          {/* DM Policy */}
          <div className="grid gap-1.5">
            <label className="text-xs font-medium" htmlFor="weixin-dm-policy">
              {q.dmPolicyLabel}
            </label>
            <select
              className={cn(
                CREDENTIAL_CONTROL_CLASS,
                'h-8 w-full max-w-xl rounded-md border border-(--ui-stroke-secondary) bg-background px-2.5 text-xs'
              )}
              id="weixin-dm-policy"
              onChange={event => setDmPolicy(event.target.value as WeixinDmPolicy)}
              value={dmPolicy}
            >
              {DM_POLICY_OPTIONS.map(opt => (
                <option key={opt} value={opt}>
                  {q.dmPolicies[opt]}
                </option>
              ))}
            </select>
            <p className="text-[0.72rem] text-muted-foreground">{q.dmPolicyHelp}</p>
          </div>

          {/* Allowed WeChat User IDs */}
          {dmPolicy !== 'disabled' && (
            <div className="grid gap-1.5">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-xs font-medium">{q.allowedUsersLabel}</span>
                {detectedUserId && allowedIds.includes(detectedUserId) && (
                  <Badge variant="success">{q.ownerDetected(detectedUserId)}</Badge>
                )}
              </div>
              <p className="text-[0.72rem] text-muted-foreground">{q.allowedUsersHelp}</p>
              <div className="flex flex-wrap gap-1.5">
                {allowedIds.map(id => (
                  <button
                    aria-label={`${t.common.remove} ${id}`}
                    className={cn(
                      'inline-flex items-center gap-1 rounded-md border border-(--ui-stroke-secondary) px-2 py-1 font-mono text-xs',
                      'hover:border-destructive/50 hover:text-destructive'
                    )}
                    key={id}
                    onClick={() => setAllowedIds(ids => ids.filter(existing => existing !== id))}
                    type="button"
                  >
                    {id}
                    <X className="size-3" />
                  </button>
                ))}
              </div>
              <div className="flex max-w-xl items-center gap-2">
                <Input
                  className={CREDENTIAL_CONTROL_CLASS}
                  onChange={event => setNewAllowedId(event.target.value)}
                  onKeyDown={event => {
                    if (isSubmitEnter(event)) {
                      event.preventDefault()
                      addAllowedId()
                    }
                  }}
                  placeholder={q.allowedUsersPlaceholder}
                  value={newAllowedId}
                />
                <Button onClick={addAllowedId} size="sm" variant="secondary">
                  <Check />
                  {q.add}
                </Button>
              </div>
            </div>
          )}

          {/* Group Chat Policy */}
          <div className="grid gap-1.5">
            <label className="text-xs font-medium" htmlFor="weixin-group-policy">
              {q.groupPolicyLabel}
            </label>
            <select
              className={cn(
                CREDENTIAL_CONTROL_CLASS,
                'h-8 w-full max-w-xl rounded-md border border-(--ui-stroke-secondary) bg-background px-2.5 text-xs'
              )}
              id="weixin-group-policy"
              onChange={event => setGroupPolicy(event.target.value as WeixinGroupPolicy)}
              value={groupPolicy}
            >
              {GROUP_POLICY_OPTIONS.map(opt => (
                <option key={opt} value={opt}>
                  {q.groupPolicies[opt]}
                </option>
              ))}
            </select>
            <p className="text-[0.72rem] text-muted-foreground">{q.groupPolicyHelp}</p>
          </div>

          {groupPolicy === 'allowlist' && (
            <div className="grid gap-1.5">
              <span className="text-xs font-medium">{q.groupAllowedLabel}</span>
              <div className="flex flex-wrap gap-1.5">
                {groupAllowedIds.map(id => (
                  <button
                    aria-label={`${t.common.remove} ${id}`}
                    className={cn(
                      'inline-flex items-center gap-1 rounded-md border border-(--ui-stroke-secondary) px-2 py-1 font-mono text-xs',
                      'hover:border-destructive/50 hover:text-destructive'
                    )}
                    key={id}
                    onClick={() => setGroupAllowedIds(ids => ids.filter(existing => existing !== id))}
                    type="button"
                  >
                    {id}
                    <X className="size-3" />
                  </button>
                ))}
              </div>
              <div className="flex max-w-xl items-center gap-2">
                <Input
                  className={CREDENTIAL_CONTROL_CLASS}
                  onChange={event => setNewGroupAllowedId(event.target.value)}
                  onKeyDown={event => {
                    if (isSubmitEnter(event)) {
                      event.preventDefault()
                      addGroupAllowedId()
                    }
                  }}
                  placeholder={q.groupAllowedPlaceholder}
                  value={newGroupAllowedId}
                />
                <Button onClick={addGroupAllowedId} size="sm" variant="secondary">
                  <Check />
                  {q.add}
                </Button>
              </div>
            </div>
          )}

          {/* Home Channel Toggle */}
          <div className="flex items-start justify-between gap-3 rounded-md border border-(--ui-stroke-secondary) p-2.5">
            <div className="min-w-0">
              <div className="text-xs font-medium">{q.homeChannelLabel}</div>
              <div className="mt-0.5 text-[0.72rem] text-muted-foreground">{q.homeChannelHelp}</div>
            </div>
            <Switch checked={setHomeChannel} onCheckedChange={setSetHomeChannel} size="xs" />
          </div>

          {/* Save & Restart Actions */}
          <div className="flex flex-wrap items-center gap-2 pt-1">
            {setup && (phase === 'connected' || phase === 'applying') ? (
              <>
                <Button disabled={phase === 'applying'} onClick={() => void applyOnboarding()} size="sm">
                  <Save />
                  {phase === 'applying' ? q.applying : q.saveAndConnect}
                </Button>
                <Button disabled={phase === 'applying'} onClick={() => void cancelQr()} size="sm" variant="ghost">
                  {t.common.cancel}
                </Button>
              </>
            ) : (
              <Button disabled={phase === 'applying'} onClick={() => void saveConfigOnly()} size="sm">
                <Save />
                {phase === 'applying' ? q.applying : q.saveWizardConfig}
              </Button>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
