import { hermesApi } from './client'

export interface EnterpriseKbDataset {
  id: string
  name: string
  document_count: number
  description?: string
  permission?: string
  avatar?: string
}

export interface EnterpriseKbStatusResponse {
  logged_in: boolean
  username?: string
  base_url?: string
  datasets?: EnterpriseKbDataset[]
  logged_in_at?: string
}

export interface EnterpriseKbLoginResponse {
  success: boolean
  username?: string
  base_url?: string
  datasets?: EnterpriseKbDataset[]
}

export function getEnterpriseKbStatus(): Promise<EnterpriseKbStatusResponse> {
  return hermesApi<EnterpriseKbStatusResponse>({
    path: '/api/enterprise-kb/status'
  })
}

export function loginEnterpriseKb(
  username: string,
  password: string,
  baseUrl?: string
): Promise<EnterpriseKbLoginResponse> {
  return hermesApi<EnterpriseKbLoginResponse>({
    path: '/api/enterprise-kb/login',
    method: 'POST',
    body: { username, password, base_url: baseUrl || 'http://172.22.0.87' }
  })
}

export function getEnterpriseKbDatasets(): Promise<{ datasets: EnterpriseKbDataset[] }> {
  return hermesApi<{ datasets: EnterpriseKbDataset[] }>({
    path: '/api/enterprise-kb/datasets'
  })
}

export function logoutEnterpriseKb(): Promise<{ success: boolean }> {
  return hermesApi<{ success: boolean }>({
    path: '/api/enterprise-kb/logout',
    method: 'POST'
  })
}

export function setSessionEnterpriseKbDatasets(
  sessionId: string,
  datasetIds: string[]
): Promise<{ success: boolean }> {
  return hermesApi<{ success: boolean }>({
    path: '/api/enterprise-kb/session-datasets',
    method: 'POST',
    body: { session_id: sessionId, dataset_ids: datasetIds }
  })
}
