import { atom } from 'nanostores'

import {
  type EnterpriseKbDataset,
  type EnterpriseKbStatusResponse,
  getEnterpriseKbStatus,
  setSessionEnterpriseKbDatasets
} from '@/hermes'

export const $enterpriseKbStatus = atom<EnterpriseKbStatusResponse | null>(null)
export const $selectedDatasetsBySession = atom<Record<string, string[]>>({})
export const $showKbLoginDialog = atom<boolean>(false)

export async function refreshEnterpriseKbStatus(): Promise<EnterpriseKbStatusResponse | null> {
  try {
    const res = await getEnterpriseKbStatus()
    $enterpriseKbStatus.set(res)
    return res
  } catch (err) {
    console.debug('Failed to get enterprise KB status:', err)
    return null
  }
}

export function openKbLoginDialog(): void {
  $showKbLoginDialog.set(true)
}

export function closeKbLoginDialog(): void {
  $showKbLoginDialog.set(false)
}

export const DRAFT_SESSION_KEY = '__draft__'

export function setSelectedDatasetsForSession(
  sessionId: string | null | undefined,
  datasetIds: string[],
  alternateSessionId?: string | null | undefined
): void {
  const key = sessionId || DRAFT_SESSION_KEY
  const cur = $selectedDatasetsBySession.get()
  const updated: Record<string, string[]> = {
    ...cur,
    [key]: datasetIds
  }
  if (alternateSessionId && alternateSessionId !== key) {
    updated[alternateSessionId] = datasetIds
  }
  $selectedDatasetsBySession.set(updated)

  // Sync with backend in background
  if (sessionId) {
    setSessionEnterpriseKbDatasets(sessionId, datasetIds).catch(err => {
      console.debug('Failed to sync session datasets with backend:', err)
    })
  }
  if (alternateSessionId && alternateSessionId !== sessionId) {
    setSessionEnterpriseKbDatasets(alternateSessionId, datasetIds).catch(err => {
      console.debug('Failed to sync alternate session datasets with backend:', err)
    })
  }
}

export async function commitDraftDatasetsToSession(
  sessionId: string,
  alternateSessionId?: string | null | undefined
): Promise<void> {
  if (!sessionId) return
  const map = $selectedDatasetsBySession.get()
  const draftSelection = map[DRAFT_SESSION_KEY]
  if (draftSelection !== undefined) {
    setSelectedDatasetsForSession(sessionId, draftSelection, alternateSessionId)
    try {
      await setSessionEnterpriseKbDatasets(sessionId, draftSelection)
      if (alternateSessionId && alternateSessionId !== sessionId) {
        await setSessionEnterpriseKbDatasets(alternateSessionId, draftSelection)
      }
    } catch (err) {
      console.debug('Failed to sync session datasets with backend:', err)
    }
  }
}

export function getSelectedDatasetsForSession(
  sessionId: string | null | undefined,
  alternateSessionId?: string | null | undefined
): string[] {
  const map = $selectedDatasetsBySession.get()
  const key = sessionId || DRAFT_SESSION_KEY
  if (key in map) {
    return map[key]
  }
  if (alternateSessionId && alternateSessionId in map) {
    return map[alternateSessionId]
  }
  // Default to all datasets if logged in and not explicitly modified yet
  const status = $enterpriseKbStatus.get()
  if (status?.logged_in && status.datasets && status.datasets.length > 0) {
    return status.datasets.map((d: EnterpriseKbDataset) => d.id)
  }
  return []
}
