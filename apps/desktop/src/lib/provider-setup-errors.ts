const PROVIDER_SETUP_ERROR_RE =
  /No (?:inference|Hermes|LLM) provider(?: is)? configured|no_provider_configured|set an API key|not connected to any AI provider|is set in config\.yaml but no (?:API key|credentials) (?:was|were) found|no credentials found|尚未配置|未连接到任何 AI|未找到.*凭证|未配置.*凭证|尚未登录/i

const SESSION_INFO_CREDENTIAL_WARNING_RE = /^No API key configured for provider '[^']*'\. First message will fail\.$/

export function isProviderSetupErrorMessage(message: null | string | undefined): boolean {
  const text = message?.trim()

  if (!text) {
    return false
  }

  return PROVIDER_SETUP_ERROR_RE.test(text) || SESSION_INFO_CREDENTIAL_WARNING_RE.test(text)
}
