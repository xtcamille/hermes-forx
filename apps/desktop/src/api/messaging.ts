import type {
  MessagingPlatformsResponse,
  MessagingPlatformTestResponse,
  MessagingPlatformUpdate,
  PairingResponse,
  PairingUser,
  TelegramOnboardingApplyResponse,
  TelegramOnboardingStartResponse,
  TelegramOnboardingStatusResponse,
  WebhookCreatePayload,
  WebhookCreateResponse,
  WebhookEnableResponse,
  WebhooksResponse,
  WeixinConfigUpdatePayload,
  WeixinDependenciesStatus,
  WeixinOnboardingApplyPayload,
  WeixinOnboardingApplyResponse,
  WeixinOnboardingStartPayload,
  WeixinOnboardingStatusResponse
} from '@/types/hermes'

import { hermesApi, profileScoped } from './client'

export function getMessagingPlatforms(profile?: null | string): Promise<MessagingPlatformsResponse> {
  return hermesApi<MessagingPlatformsResponse>({
    ...profileScoped(profile),
    path: '/api/messaging/platforms'
  })
}

/** `hot_served`: a live multiplexer serving this named profile rebuilt its adapters from the new
 *  credentials right away — no gateway restart is needed for the change to take effect. */
export interface MessagingPlatformUpdateResponse {
  hot_served?: boolean
  ok: boolean
  platform: string
}

export function updateMessagingPlatform(
  platformId: string,
  body: MessagingPlatformUpdate,
  profile?: null | string
): Promise<MessagingPlatformUpdateResponse> {
  return hermesApi<MessagingPlatformUpdateResponse>({
    ...profileScoped(profile),
    path: `/api/messaging/platforms/${encodeURIComponent(platformId)}`,
    method: 'PUT',
    body
  })
}

export function testMessagingPlatform(
  platformId: string,
  profile?: null | string
): Promise<MessagingPlatformTestResponse> {
  return hermesApi<MessagingPlatformTestResponse>({
    ...profileScoped(profile),
    path: `/api/messaging/platforms/${encodeURIComponent(platformId)}/test`,
    method: 'POST'
  })
}

// -- Telegram QR onboarding ---------------------------------------------------
// Pairing state lives in the memory of the backend process that started it, so
// every call in one flow carries the SAME profile scope — the Electron router
// picks the backend from it, and a mismatched apply would 404 the pairing.

export function startTelegramOnboarding(
  botName?: string,
  profile?: null | string
): Promise<TelegramOnboardingStartResponse> {
  return hermesApi<TelegramOnboardingStartResponse>({
    ...profileScoped(profile),
    path: '/api/messaging/telegram/onboarding/start',
    method: 'POST',
    body: botName ? { bot_name: botName } : {}
  })
}

export function getTelegramOnboardingStatus(
  pairingId: string,
  profile?: null | string
): Promise<TelegramOnboardingStatusResponse> {
  return hermesApi<TelegramOnboardingStatusResponse>({
    ...profileScoped(profile),
    path: `/api/messaging/telegram/onboarding/${encodeURIComponent(pairingId)}`
  })
}

export function applyTelegramOnboarding(
  pairingId: string,
  allowedUserIds: string[],
  profile?: null | string
): Promise<TelegramOnboardingApplyResponse> {
  const scope = profileScoped(profile)

  return hermesApi<TelegramOnboardingApplyResponse>({
    ...scope,
    path: `/api/messaging/telegram/onboarding/${encodeURIComponent(pairingId)}/apply`,
    method: 'POST',
    body: { allowed_user_ids: allowedUserIds, profile: scope.profile }
  })
}

export function cancelTelegramOnboarding(pairingId: string, profile?: null | string): Promise<{ ok: boolean }> {
  return hermesApi<{ ok: boolean }>({
    ...profileScoped(profile),
    path: `/api/messaging/telegram/onboarding/${encodeURIComponent(pairingId)}`,
    method: 'DELETE'
  })
}

// -- Weixin / WeChat QR onboarding & setup wizard -----------------------------

export function getWeixinDependencies(profile?: null | string): Promise<WeixinDependenciesStatus> {
  return hermesApi<WeixinDependenciesStatus>({
    ...profileScoped(profile),
    path: '/api/messaging/weixin/dependencies'
  })
}

export function installWeixinDependencies(
  includeOptional = true,
  profile?: null | string
): Promise<WeixinDependenciesStatus> {
  const scope = profileScoped(profile)

  return hermesApi<WeixinDependenciesStatus>({
    ...scope,
    path: '/api/messaging/weixin/dependencies/install',
    method: 'POST',
    timeoutMs: 180_000,
    body: { include_optional: includeOptional, profile: scope.profile }
  })
}

export function startWeixinOnboarding(
  payload: WeixinOnboardingStartPayload = {},
  profile?: null | string
): Promise<WeixinOnboardingStatusResponse> {
  const scope = profileScoped(profile)

  return hermesApi<WeixinOnboardingStatusResponse>({
    ...scope,
    path: '/api/messaging/weixin/onboarding/start',
    method: 'POST',
    body: { ...payload, profile: scope.profile }
  })
}

export function getWeixinOnboardingStatus(
  pairingId: string,
  profile?: null | string
): Promise<WeixinOnboardingStatusResponse> {
  return hermesApi<WeixinOnboardingStatusResponse>({
    ...profileScoped(profile),
    path: `/api/messaging/weixin/onboarding/${encodeURIComponent(pairingId)}`
  })
}

export function applyWeixinOnboarding(
  pairingId: string,
  payload: WeixinOnboardingApplyPayload = {},
  profile?: null | string
): Promise<WeixinOnboardingApplyResponse> {
  const scope = profileScoped(profile)

  return hermesApi<WeixinOnboardingApplyResponse>({
    ...scope,
    path: `/api/messaging/weixin/onboarding/${encodeURIComponent(pairingId)}/apply`,
    method: 'POST',
    body: { ...payload, profile: scope.profile }
  })
}

export function cancelWeixinOnboarding(pairingId: string, profile?: null | string): Promise<{ ok: boolean }> {
  return hermesApi<{ ok: boolean }>({
    ...profileScoped(profile),
    path: `/api/messaging/weixin/onboarding/${encodeURIComponent(pairingId)}`,
    method: 'DELETE'
  })
}

export function updateWeixinConfig(
  payload: WeixinConfigUpdatePayload,
  profile?: null | string
): Promise<WeixinOnboardingApplyResponse> {
  const scope = profileScoped(profile)

  return hermesApi<WeixinOnboardingApplyResponse>({
    ...scope,
    path: '/api/messaging/weixin/config',
    method: 'POST',
    body: { ...payload, profile: scope.profile }
  })
}


// -- Pairing (who may DM the bot) --------------------------------------------
// Unknown DMers get a one-time code and land in `pending` until an admin
// approves them. Approval grants on the row's `request_id`, never on the code:
// the code is the requester's proof that the channel is theirs and is never
// returned by the API, while an authenticated admin is only ever identifying
// a row they can already see.

export function getPairing(profile?: null | string): Promise<PairingResponse> {
  return hermesApi<PairingResponse>({
    ...profileScoped(profile),
    path: '/api/pairing'
  })
}

export function approvePairing(
  platform: string,
  requestId: string,
  profile?: null | string
): Promise<{ ok: boolean; user: PairingUser }> {
  const scope = profileScoped(profile)

  return hermesApi<{ ok: boolean; user: PairingUser }>({
    ...scope,
    path: '/api/pairing/approve',
    method: 'POST',
    // These endpoints read the profile off the body, not the query string —
    // the request scope alone would approve into the wrong profile's store.
    body: { platform, request_id: requestId, profile: scope.profile }
  })
}

export function revokePairing(platform: string, userId: string, profile?: null | string): Promise<{ ok: boolean }> {
  const scope = profileScoped(profile)

  return hermesApi<{ ok: boolean }>({
    ...scope,
    path: '/api/pairing/revoke',
    method: 'POST',
    body: { platform, user_id: userId, profile: scope.profile }
  })
}

// -- Webhooks (subscription CRUD) --------------------------------------------
// The webhook receiver is its own gateway platform; subscriptions live in a
// shared JSON store the CLI/dashboard also drive. Enable mutates config and
// best-effort restarts the gateway; subscription changes hot-reload.

export function getWebhooks(): Promise<WebhooksResponse> {
  return hermesApi<WebhooksResponse>({
    ...profileScoped(),
    path: '/api/webhooks'
  })
}

export function enableWebhooks(): Promise<WebhookEnableResponse> {
  return hermesApi<WebhookEnableResponse>({
    ...profileScoped(),
    path: '/api/webhooks/enable',
    method: 'POST'
  })
}

export function createWebhook(body: WebhookCreatePayload): Promise<WebhookCreateResponse> {
  return hermesApi<WebhookCreateResponse>({
    ...profileScoped(),
    path: '/api/webhooks',
    method: 'POST',
    body
  })
}

export function deleteWebhook(name: string): Promise<{ ok: boolean }> {
  return hermesApi<{ ok: boolean }>({
    ...profileScoped(),
    path: `/api/webhooks/${encodeURIComponent(name)}`,
    method: 'DELETE'
  })
}

export function setWebhookEnabled(
  name: string,
  enabled: boolean
): Promise<{ enabled: boolean; name: string; ok: boolean }> {
  return hermesApi<{ enabled: boolean; name: string; ok: boolean }>({
    ...profileScoped(),
    path: `/api/webhooks/${encodeURIComponent(name)}/enabled`,
    method: 'PUT',
    body: { enabled }
  })
}
