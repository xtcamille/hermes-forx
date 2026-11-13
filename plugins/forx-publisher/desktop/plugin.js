import {
  host,
  useValue,
  haptic,
  isSubmitEnter,
  Button,
  Badge,
  Input,
  SegmentedControl,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  CopyButton,
  icons,
  PANES_AREA,
  ROUTES_AREA,
  SIDEBAR_NAV_AREA,
  PALETTE_AREA,
} from '@hermes/plugin-sdk'
import { jsx, jsxs } from 'react/jsx-runtime'
import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react'

const PLUGIN_ID = 'forx-publisher'
const GITHUB_NEW_TOKEN_URL =
  'https://github.com/settings/tokens/new?scopes=public_repo&description=Hermes+Community+Publisher'

const CATEGORIES = [
  { id: 'tools', label: 'tools（工具扩展）' },
  { id: 'desktop', label: 'desktop（桌面界面）' },
  { id: 'web', label: 'web（网页与检索）' },
  { id: 'automation', label: 'automation（自动化）' },
  { id: 'memory', label: 'memory（记忆系统）' },
  { id: 'models', label: 'models（模型接入）' },
  { id: 'voice', label: 'voice（语音交互）' },
  { id: 'platform', label: 'platform（消息平台）' },
  { id: 'general', label: 'general（通用）' },
]

// Disk plugins are not scanned by Desktop's Tailwind build, so all layout and
// status styling lives here against the host theme's CSS tokens.
const CSS = `
.forx-pub-root {
  max-width: 54rem;
  width: 100%;
  margin: 0 auto;
  padding: 28px 24px 40px;
  height: 100%;
  overflow-y: auto;
  color: var(--ui-text-primary);
  display: flex;
  flex-direction: column;
  gap: 20px;
  box-sizing: border-box;
}
.forx-pub-header {
  display: flex;
  align-items: center;
  gap: 12px;
}
.forx-pub-logo {
  width: 40px;
  height: 40px;
  border-radius: 12px;
  background: color-mix(in srgb, var(--ui-accent, #3b82f6) 14%, transparent);
  color: var(--ui-accent, #3b82f6);
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}
.forx-pub-title {
  margin: 0;
  font-size: 18px;
  font-weight: 700;
  line-height: 1.3;
  letter-spacing: -0.01em;
  color: var(--ui-text-primary);
}
.forx-pub-subtitle {
  margin: 3px 0 0;
  font-size: 12px;
  line-height: 1.5;
  color: var(--ui-text-secondary);
}
.forx-pub-auth {
  border-radius: 12px;
  border: 1px solid var(--ui-stroke-secondary);
  background: var(--ui-bg-editor);
  padding: 14px 16px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.forx-pub-auth[data-state="ok"] {
  border-color: color-mix(in srgb, #10b981 30%, var(--ui-stroke-secondary));
  background: color-mix(in srgb, #10b981 6%, var(--ui-bg-editor));
}
.forx-pub-auth[data-state="warn"] {
  border-color: color-mix(in srgb, #f59e0b 32%, var(--ui-stroke-secondary));
  background: color-mix(in srgb, #f59e0b 6%, var(--ui-bg-editor));
}
.forx-pub-auth-top {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
}
.forx-pub-auth-lead {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  min-width: 0;
  flex: 1;
}
.forx-pub-auth-icon {
  width: 32px;
  height: 32px;
  border-radius: 999px;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  font-weight: 700;
  font-size: 14px;
}
.forx-pub-auth[data-state="ok"] .forx-pub-auth-icon {
  background: color-mix(in srgb, #10b981 18%, transparent);
  color: #10b981;
}
.forx-pub-auth[data-state="warn"] .forx-pub-auth-icon {
  background: color-mix(in srgb, #f59e0b 18%, transparent);
  color: #d97706;
}
.forx-pub-auth[data-state="loading"] .forx-pub-auth-icon {
  background: var(--ui-bg-tertiary);
  color: var(--ui-text-tertiary);
}
.forx-pub-auth-title {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  font-size: 13px;
  font-weight: 600;
  color: var(--ui-text-primary);
}
.forx-pub-auth-desc {
  margin-top: 3px;
  font-size: 12px;
  line-height: 1.5;
  color: var(--ui-text-secondary);
}
.forx-pub-auth-actions {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
  flex-wrap: wrap;
}
.forx-pub-auth-setup {
  border-top: 1px solid var(--ui-stroke-secondary);
  padding-top: 12px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.forx-pub-auth-step {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  flex-wrap: wrap;
  font-size: 12px;
  color: var(--ui-text-secondary);
}
.forx-pub-auth-step-text {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  line-height: 1.5;
}
.forx-pub-step-num-pill {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  border-radius: 999px;
  font-size: 11px;
  font-weight: 600;
  background: var(--ui-bg-tertiary);
  color: var(--ui-text-primary);
  flex-shrink: 0;
}
.forx-pub-token-row {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.forx-pub-token-input-wrap {
  flex: 1;
  min-width: 240px;
  display: flex;
  align-items: center;
  gap: 4px;
}
.forx-pub-cli-alt {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  flex-wrap: wrap;
  padding: 8px 10px;
  border-radius: 8px;
  background: color-mix(in srgb, var(--ui-bg-tertiary) 65%, transparent);
  font-size: 11.5px;
  color: var(--ui-text-secondary);
}
.forx-pub-cli-alt-left {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}
.forx-pub-steps {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 4px 0 14px;
  border-bottom: 1px solid var(--ui-stroke-secondary);
}
.forx-pub-step-btn {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  background: transparent;
  border: none;
  padding: 4px 6px;
  border-radius: 8px;
  font-size: 12.5px;
  font-weight: 500;
  color: var(--ui-text-tertiary);
  cursor: default;
  white-space: nowrap;
  transition: color 0.15s ease, background 0.15s ease;
}
.forx-pub-step-btn[data-clickable="true"] {
  cursor: pointer;
}
.forx-pub-step-btn[data-clickable="true"]:hover {
  background: var(--chrome-action-hover, var(--ui-bg-tertiary));
}
.forx-pub-step-btn[data-state="active"] {
  color: var(--ui-text-primary);
  font-weight: 600;
}
.forx-pub-step-btn[data-state="done"] {
  color: #10b981;
}
.forx-pub-step-circle {
  width: 22px;
  height: 22px;
  border-radius: 999px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 11px;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
  flex-shrink: 0;
  background: var(--ui-bg-tertiary);
  color: var(--ui-text-tertiary);
  border: 1px solid var(--ui-stroke-secondary);
}
.forx-pub-step-btn[data-state="active"] .forx-pub-step-circle {
  background: var(--dt-primary-solid, #2563eb);
  color: var(--dt-primary-solid-foreground, #ffffff);
  border-color: transparent;
}
.forx-pub-step-btn[data-state="done"] .forx-pub-step-circle {
  background: #10b981;
  color: #ffffff;
  border-color: transparent;
}
.forx-pub-step-line {
  flex: 1;
  height: 1px;
  min-width: 16px;
  background: var(--ui-stroke-secondary);
}
.forx-pub-step-line[data-done="true"] {
  background: color-mix(in srgb, #10b981 45%, transparent);
}
.forx-pub-section {
  display: flex;
  flex-direction: column;
  gap: 16px;
}
.forx-pub-card {
  border-radius: 12px;
  border: 1px solid var(--ui-stroke-secondary);
  background: var(--ui-bg-editor);
  padding: 18px 20px;
  display: flex;
  flex-direction: column;
  gap: 16px;
}
.forx-pub-card[data-tone="ok"] {
  border-color: color-mix(in srgb, #10b981 32%, var(--ui-stroke-secondary));
  background: color-mix(in srgb, #10b981 6%, var(--ui-bg-editor));
}
.forx-pub-card[data-tone="warn"] {
  border-color: color-mix(in srgb, #f59e0b 32%, var(--ui-stroke-secondary));
  background: color-mix(in srgb, #f59e0b 6%, var(--ui-bg-editor));
}
.forx-pub-card[data-tone="error"] {
  border-color: color-mix(in srgb, #ef4444 35%, var(--ui-stroke-secondary));
  background: color-mix(in srgb, #ef4444 6%, var(--ui-bg-editor));
}
.forx-pub-field {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.forx-pub-label {
  font-size: 12px;
  font-weight: 600;
  color: var(--ui-text-primary);
}
.forx-pub-hint {
  margin: 0;
  font-size: 11.5px;
  line-height: 1.45;
  color: var(--ui-text-tertiary);
}
.forx-pub-path-row {
  display: flex;
  align-items: center;
  gap: 8px;
}
.forx-pub-grid-2 {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 14px;
}
@media (max-width: 640px) {
  .forx-pub-grid-2 {
    grid-template-columns: 1fr;
  }
}
.forx-pub-alert {
  padding: 10px 12px;
  border-radius: 8px;
  font-size: 12px;
  line-height: 1.5;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.forx-pub-alert[data-tone="error"] {
  background: color-mix(in srgb, #ef4444 10%, transparent);
  border: 1px solid color-mix(in srgb, #ef4444 28%, transparent);
  color: #ef4444;
}
.forx-pub-alert[data-tone="warn"] {
  background: color-mix(in srgb, #f59e0b 10%, transparent);
  border: 1px solid color-mix(in srgb, #f59e0b 28%, transparent);
  color: #d97706;
}
.forx-pub-alert[data-tone="ok"] {
  background: color-mix(in srgb, #10b981 10%, transparent);
  border: 1px solid color-mix(in srgb, #10b981 28%, transparent);
  color: #10b981;
}
.forx-pub-checklist {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.forx-pub-check-item {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  font-size: 12px;
  line-height: 1.45;
  color: var(--ui-text-secondary);
}
.forx-pub-check-dot {
  width: 16px;
  height: 16px;
  border-radius: 999px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 10px;
  font-weight: 700;
  flex-shrink: 0;
  margin-top: 1px;
}
.forx-pub-check-dot[data-ok="true"] {
  background: color-mix(in srgb, #10b981 16%, transparent);
  color: #10b981;
}
.forx-pub-check-dot[data-ok="false"] {
  background: color-mix(in srgb, #ef4444 16%, transparent);
  color: #ef4444;
}
.forx-pub-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
  padding-top: 4px;
}
.forx-pub-footer-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.forx-pub-code {
  font-family: var(--font-mono, monospace);
  font-size: 11px;
  padding: 2px 6px;
  border-radius: 5px;
  background: var(--ui-inline-code-background, color-mix(in srgb, var(--ui-text-primary) 7%, transparent));
  color: var(--ui-inline-code-foreground, var(--ui-text-primary));
}
.forx-pub-pre {
  margin: 0;
  padding: 12px 14px;
  border-radius: 8px;
  background: var(--ui-bg-chrome);
  border: 1px solid var(--ui-stroke-secondary);
  color: var(--ui-text-primary);
  font-family: var(--font-mono, monospace);
  font-size: 11.5px;
  line-height: 1.55;
  overflow-x: auto;
  white-space: pre;
}
.forx-pub-center-hero {
  text-align: center;
  align-items: center;
  padding: 26px 20px;
}
.forx-pub-pane {
  padding: 16px;
  display: flex;
  flex-direction: column;
  gap: 14px;
  font-size: 12px;
  height: 100%;
  overflow-y: auto;
  color: var(--ui-text-primary);
  box-sizing: border-box;
}
.forx-pub-pane-title {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13.5px;
  font-weight: 600;
  padding-bottom: 10px;
  border-bottom: 1px solid var(--ui-stroke-secondary);
}
`

function openExternalUrl(ctx, url) {
  if (!url) return
  if (ctx?.os?.openExternal) {
    void ctx.os.openExternal(url).then((ok) => {
      if (!ok && typeof window !== 'undefined') window.open(url, '_blank', 'noopener,noreferrer')
    })
    return
  }
  if (typeof window !== 'undefined') {
    window.open(url, '_blank', 'noopener,noreferrer')
  }
}

function formatMethodLabel(method) {
  if (method === 'pat') return 'PAT (.env)'
  if (method === 'gh-cli') return 'gh CLI'
  if (method === 'github-app') return 'GitHub App'
  return method || 'PAT'
}

function extractApiError(err, fallback) {
  if (!err) return fallback
  if (typeof err === 'string') return err
  if (err.detail && typeof err.detail === 'string') return err.detail
  if (err.message && typeof err.message === 'string') return err.message
  return fallback
}

function buildCatalogYamlPreview(checkResult, { gitUrl, commitSha, category, maintainer }) {
  if (!checkResult?.catalog_yaml_preview) return ''
  const preview = checkResult.catalog_preview || {}
  const name = preview.name || checkResult.name || 'my-plugin'
  const repo = (gitUrl || preview.repo || `https://github.com/your-username/${name}`).trim()
  const sha = (commitSha || preview.sha || '0'.repeat(40)).trim()
  const desc = (preview.description || checkResult.description || '').replace(/\n/g, ' ').trim()
  const maint = (maintainer || preview.maintainer || 'YourName').trim()
  const cat = category || preview.category || 'tools'
  const version = preview.version || checkResult.version || '0.1.0'
  const caps = preview.capabilities || {}

  const quote = (val) => {
    const s = String(val ?? '')
    return /[:#\[\]{}&*!|>'"%@`]|\s$|^$/.test(s) ? JSON.stringify(s) : s
  }
  const listLines = (key, items) => {
    const arr = Array.isArray(items) ? items : []
    if (!arr.length) return `  ${key}: []`
    return `  ${key}:\n` + arr.map((item) => `    - ${quote(item)}`).join('\n')
  }

  return [
    `name: ${quote(name)}`,
    `repo: ${quote(repo)}`,
    `sha: ${quote(sha)}`,
    `description: ${quote(desc)}`,
    `maintainer: ${quote(maint)}`,
    `tier: community`,
    `category: ${quote(cat)}`,
    `version: ${quote(version)}`,
    `capabilities:`,
    listLines('provides_tools', caps.provides_tools),
    listLines('provides_hooks', caps.provides_hooks),
    listLines('provides_middleware', caps.provides_middleware),
    listLines('requires_env', caps.requires_env),
  ].join('\n')
}

// ─────────────────────────────────────────────────────────────
// COMPONENT: GitHub Auth Status & Friendly Setup Banner
// ─────────────────────────────────────────────────────────────
function AuthBanner({ ctx, auth, loadingAuth, onRefresh, onAuthUpdated, inputRef }) {
  const isAuthed = Boolean(auth?.authenticated)
  const [editing, setEditing] = useState(false)
  const [tokenInput, setTokenInput] = useState('')
  const [showToken, setShowToken] = useState(false)
  const [saving, setSaving] = useState(false)
  const [clearing, setClearing] = useState(false)
  const [tokenError, setTokenError] = useState('')
  const [showCliHelp, setShowCliHelp] = useState(false)

  const stateAttr = loadingAuth && !auth ? 'loading' : isAuthed ? 'ok' : 'warn'
  const showSetup = !isAuthed ? Boolean(auth) : editing

  const handleSaveToken = async () => {
    const trimmed = tokenInput.trim()
    if (!trimmed) {
      setTokenError('请先粘贴 GitHub Personal Access Token。')
      return
    }
    setSaving(true)
    setTokenError('')
    try {
      const res = await ctx.rest('/auth/token', {
        method: 'POST',
        body: { token: trimmed },
      })
      haptic('success')
      setTokenInput('')
      setEditing(false)
      onAuthUpdated(res)
    } catch (err) {
      haptic('error')
      setTokenError(extractApiError(err, '验证或保存 Token 失败，请检查后重试。'))
    } finally {
      setSaving(false)
    }
  }

  const handleClearToken = async () => {
    setClearing(true)
    setTokenError('')
    try {
      const res = await ctx.rest('/auth/token', { method: 'DELETE' })
      haptic('success')
      setEditing(false)
      onAuthUpdated(res?.auth || { authenticated: false })
    } catch (err) {
      haptic('error')
      setTokenError(extractApiError(err, '清除 Token 失败。'))
    } finally {
      setClearing(false)
    }
  }

  return jsxs('div', {
    className: 'forx-pub-auth',
    'data-state': stateAttr,
    children: [
      jsxs('div', {
        className: 'forx-pub-auth-top',
        children: [
          jsxs('div', {
            className: 'forx-pub-auth-lead',
            children: [
              jsx('div', {
                className: 'forx-pub-auth-icon',
                children:
                  stateAttr === 'loading'
                    ? '…'
                    : isAuthed
                      ? jsx(icons.Check, { className: 'size-4' })
                      : jsx(icons.KeyRound, { className: 'size-4' }),
              }),
              jsxs('div', {
                style: { minWidth: 0, flex: 1 },
                children: [
                  jsxs('div', {
                    className: 'forx-pub-auth-title',
                    children: [
                      jsx('span', {
                        children:
                          stateAttr === 'loading'
                            ? '正在检测 GitHub 认证状态…'
                            : isAuthed
                              ? 'GitHub 凭据已就绪'
                              : '配置 GitHub 授权以开启一键提 PR',
                      }),
                      isAuthed &&
                        auth?.username &&
                        jsx(Badge, { variant: 'success', children: `@${auth.username}` }),
                      isAuthed &&
                        auth?.method &&
                        jsx(Badge, { variant: 'outline', children: formatMethodLabel(auth.method) }),
                    ],
                  }),
                  jsx('div', {
                    className: 'forx-pub-auth-desc',
                    children:
                      stateAttr === 'loading'
                        ? '正在检查本地 Token 与 GitHub CLI 凭据…'
                        : isAuthed
                          ? '已具备自动 Fork 目标仓库并发起 Pull Request 的权限。'
                          : '你可以直接填写 GitHub Token（自动保存至当前配置环境，无需手动编辑文件），或使用本机 GitHub CLI。',
                  }),
                ],
              }),
            ],
          }),
          jsxs('div', {
            className: 'forx-pub-auth-actions',
            children: [
              isAuthed &&
                jsx(Button, {
                  variant: 'outline',
                  size: 'sm',
                  onClick: () => {
                    setEditing((v) => !v)
                    setTokenError('')
                  },
                  children: editing ? '收起' : '更换 Token',
                }),
              isAuthed &&
                auth?.has_saved_token &&
                jsx(Button, {
                  variant: 'ghost',
                  size: 'sm',
                  onClick: handleClearToken,
                  disabled: clearing,
                  children: clearing ? '清除中…' : '清除 Token',
                }),
              jsxs(Button, {
                variant: 'secondary',
                size: 'sm',
                onClick: onRefresh,
                disabled: loadingAuth,
                children: [
                  jsx(icons.RefreshCw, { className: loadingAuth ? 'size-3.5 animate-spin' : 'size-3.5' }),
                  loadingAuth ? '检测中…' : '刷新状态',
                ],
              }),
            ],
          }),
        ],
      }),

      isAuthed &&
        auth?.scope_warning &&
        jsx('div', {
          className: 'forx-pub-alert',
          'data-tone': 'warn',
          children: auth.scope_warning,
        }),

      showSetup &&
        jsxs('div', {
          className: 'forx-pub-auth-setup',
          children: [
            jsxs('div', {
              className: 'forx-pub-auth-step',
              children: [
                jsxs('div', {
                  className: 'forx-pub-auth-step-text',
                  children: [
                    jsx('span', { className: 'forx-pub-step-num-pill', children: '1' }),
                    jsx('span', { children: '打开 GitHub 页面生成 Token（已为你预选' }),
                    jsx('code', { className: 'forx-pub-code', children: 'public_repo' }),
                    jsx('span', { children: '权限，点击底部 Generate token 后复制）：' }),
                  ],
                }),
                jsxs(Button, {
                  variant: 'outline',
                  size: 'sm',
                  onClick: () => openExternalUrl(ctx, GITHUB_NEW_TOKEN_URL),
                  children: [
                    jsx(icons.ExternalLink, { className: 'size-3.5' }),
                    '一键前往生成 Token',
                  ],
                }),
              ],
            }),

            jsxs('div', {
              className: 'forx-pub-auth-step',
              style: { alignItems: 'stretch', flexDirection: 'column', gap: '8px' },
              children: [
                jsxs('div', {
                  className: 'forx-pub-auth-step-text',
                  children: [
                    jsx('span', { className: 'forx-pub-step-num-pill', children: '2' }),
                    jsx('span', { children: '粘贴 Token 并验证（将自动加密写入当前 Profile 的 .env 配置）：' }),
                  ],
                }),
                jsxs('div', {
                  className: 'forx-pub-token-row',
                  children: [
                    jsxs('div', {
                      className: 'forx-pub-token-input-wrap',
                      children: [
                        jsx(Input, {
                          ref: inputRef,
                          type: showToken ? 'text' : 'password',
                          placeholder: '粘贴 GitHub Token（如 ghp_... 或 github_pat_...）',
                          value: tokenInput,
                          onChange: (e) => {
                            setTokenInput(e.target.value)
                            if (tokenError) setTokenError('')
                          },
                          onKeyDown: (e) => {
                            if (isSubmitEnter(e) && !saving) {
                              e.preventDefault()
                              void handleSaveToken()
                            }
                          },
                        }),
                        jsx(Button, {
                          variant: 'ghost',
                          size: 'icon-sm',
                          type: 'button',
                          title: showToken ? '隐藏 Token' : '显示 Token',
                          onClick: () => setShowToken((v) => !v),
                          children: jsx(showToken ? icons.EyeOff : icons.Eye, { className: 'size-3.5' }),
                        }),
                      ],
                    }),
                    jsx(Button, {
                      variant: 'default',
                      size: 'sm',
                      onClick: handleSaveToken,
                      disabled: saving || !tokenInput.trim(),
                      children: saving ? '正在验证并保存…' : '验证并保存',
                    }),
                  ],
                }),
              ],
            }),

            tokenError &&
              jsx('div', {
                className: 'forx-pub-alert',
                'data-tone': 'error',
                children: tokenError,
              }),

            jsxs('div', {
              className: 'forx-pub-cli-alt',
              children: [
                jsxs('div', {
                  className: 'forx-pub-cli-alt-left',
                  children: [
                    jsx(icons.Terminal, { className: 'size-3.5' }),
                    jsx('span', {
                      children: auth?.gh_installed
                        ? '或者你本机已安装 gh CLI，也可以运行：'
                        : '或者使用 GitHub CLI 授权：',
                    }),
                    jsx('code', { className: 'forx-pub-code', children: 'gh auth login' }),
                    jsx(CopyButton, {
                      text: 'gh auth login',
                      appearance: 'icon',
                      buttonSize: 'icon-xs',
                      title: '复制命令',
                    }),
                  ],
                }),
                jsx(Button, {
                  variant: 'text',
                  size: 'micro',
                  onClick: () => setShowCliHelp((v) => !v),
                  children: showCliHelp ? '收起说明' : '终端完成后点刷新状态即可',
                }),
              ],
            }),

            showCliHelp &&
              jsx('p', {
                className: 'forx-pub-hint',
                children:
                  '提示：如果此前在 .env 中保存过失效的 GITHUB_TOKEN，它可能会覆盖 gh CLI 登录态；建议直接在此处验证并保存新 Token，或清除旧 Token。',
              }),
          ],
        }),
    ],
  })
}

// ─────────────────────────────────────────────────────────────
// COMPONENT: Step Indicator (no duplicate numbering)
// ─────────────────────────────────────────────────────────────
function StepBar({ step, setStep, canOpenStep2 }) {
  const steps = [
    { num: 1, label: '目标配置' },
    { num: 2, label: '合规与体检' },
    { num: 3, label: '提交与发布' },
  ]

  return jsx('div', {
    className: 'forx-pub-steps',
    children: steps.flatMap((s, idx) => {
      const active = step === s.num
      const done = step > s.num
      const clickable = s.num < step || (s.num === 2 && canOpenStep2)
      const state = active ? 'active' : done ? 'done' : 'pending'

      const btn = jsxs(
        'button',
        {
          type: 'button',
          disabled: !clickable,
          'data-state': state,
          'data-clickable': clickable ? 'true' : 'false',
          onClick: () => (clickable ? setStep(s.num) : null),
          className: 'forx-pub-step-btn',
          children: [
            jsx('span', {
              className: 'forx-pub-step-circle',
              children: done ? jsx(icons.Check, { className: 'size-3' }) : s.num,
            }),
            jsx('span', { children: s.label }),
          ],
        },
        `step-${s.num}`
      )

      if (idx === steps.length - 1) return [btn]
      return [
        btn,
        jsx(
          'div',
          {
            className: 'forx-pub-step-line',
            'data-done': done ? 'true' : 'false',
          },
          `line-${s.num}`
        ),
      ]
    }),
  })
}

// ─────────────────────────────────────────────────────────────
// COMPONENT: Publisher Main View (Route /publish)
// ─────────────────────────────────────────────────────────────
function PublisherView({ ctx }) {
  const profile = useValue(host.state.profile)
  const tokenInputRef = useRef(null)

  const [targetType, setTargetType] = useState('plugin') // 'plugin' | 'skill'
  const [targetPath, setTargetPath] = useState('')
  const [category, setCategory] = useState('tools')
  const [gitUrl, setGitUrl] = useState('')
  const [commitSha, setCommitSha] = useState('')
  const [maintainer, setMaintainer] = useState('')
  const [step, setStep] = useState(1)

  // Auth state
  const [auth, setAuth] = useState(null)
  const [loadingAuth, setLoadingAuth] = useState(true)

  // Check state
  const [checkLoading, setCheckLoading] = useState(false)
  const [checkResult, setCheckResult] = useState(null)
  const [checkError, setCheckError] = useState('')

  // Publish state
  const [pubLoading, setPubLoading] = useState(false)
  const [pubResult, setPubResult] = useState(null)
  const [pubError, setPubError] = useState('')

  const fetchAuth = useCallback(() => {
    setLoadingAuth(true)
    ctx
      .rest('/auth')
      .then((res) => setAuth(res))
      .catch((err) => setAuth({ authenticated: false, error: extractApiError(err, '无法获取认证状态') }))
      .finally(() => setLoadingAuth(false))
  }, [ctx, profile])

  useEffect(() => {
    fetchAuth()
  }, [fetchAuth])

  useEffect(() => {
    if (auth?.username && !maintainer) {
      setMaintainer(auth.username)
    }
  }, [auth?.username])

  const liveYamlPreview = useMemo(
    () => buildCatalogYamlPreview(checkResult, { gitUrl, commitSha, category, maintainer }),
    [checkResult, gitUrl, commitSha, category, maintainer]
  )

  const handlePickDirectory = async () => {
    if (!ctx?.os?.pickOpenPath) return
    const picked = await ctx.os.pickOpenPath({
      directories: true,
      title: targetType === 'plugin' ? '选择本地插件目录' : '选择本地技能目录',
    })
    if (picked) {
      setTargetPath(picked)
      setCheckError('')
    }
  }

  // Step 1 -> Step 2: Run Check
  const handleRunCheck = async () => {
    if (!targetPath.trim()) {
      setCheckError('请先输入或选择本地插件/技能目录路径。')
      return
    }

    setCheckLoading(true)
    setCheckError('')
    setCheckResult(null)
    setPubResult(null)
    setPubError('')

    try {
      const res = await ctx.rest('/check', {
        method: 'POST',
        body: { path: targetPath.trim(), target_type: targetType },
      })
      setCheckResult(res)
      if (res.ok) {
        setGitUrl(res.git?.remote_url || '')
        setCommitSha(res.git?.commit_sha || '')
        setMaintainer(res.maintainer || auth?.username || '')
        if (res.category) setCategory(res.category)
        haptic('success')
        setStep(2)
      } else {
        haptic('error')
        const failures = res.validation?.failures || []
        setCheckError(res.error || (failures.length ? `共有 ${failures.length} 项合规检查未通过，请根据下方列表修正。` : '检查未通过，请排查后重试。'))
      }
    } catch (e) {
      haptic('error')
      setCheckError(extractApiError(e, '网络或接口异常'))
    } finally {
      setCheckLoading(false)
    }
  }

  // Step 2 -> Step 3: Run Publish
  const handlePublish = async (dryRun = false) => {
    setPubLoading(true)
    setPubError('')
    if (!dryRun) setPubResult(null)

    try {
      let res
      if (targetType === 'plugin') {
        res = await ctx.rest('/publish/plugin', {
          method: 'POST',
          body: {
            path: targetPath.trim(),
            repo_url: gitUrl.trim(),
            commit_sha: commitSha.trim(),
            category,
            maintainer: maintainer.trim(),
            dry_run: dryRun,
          },
        })
      } else {
        res = await ctx.rest('/publish/skill', {
          method: 'POST',
          body: {
            path: targetPath.trim(),
            skill_name: checkResult?.name || '',
            dest_dir: 'optional-skills',
            dry_run: dryRun,
          },
        })
      }

      setPubResult(res)
      if (res.ok) {
        haptic('success')
        if (!dryRun) setStep(3)
      } else {
        haptic('error')
        setPubError(res.error || '发布未成功')
      }
    } catch (e) {
      haptic('error')
      setPubError(extractApiError(e, '发布请求发生异常'))
    } finally {
      setPubLoading(false)
    }
  }

  const focusAuthInput = () => {
    tokenInputRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' })
    setTimeout(() => tokenInputRef.current?.focus(), 200)
  }

  const failureChecks = checkResult && !checkResult.ok ? checkResult.validation?.checks || [] : []
  const failureItems = checkResult && !checkResult.ok ? checkResult.validation?.failures || [] : []
  const pluginWarnings = [
    ...(checkResult?.validation?.warnings || []),
    ...(checkResult?.git?.warnings || []),
  ]

  return jsxs('div', {
    className: 'forx-pub-root',
    children: [
      // Header
      jsxs('div', {
        className: 'forx-pub-header',
        children: [
          jsx('div', {
            className: 'forx-pub-logo',
            children: jsx(icons.Upload, { className: 'size-5' }),
          }),
          jsxs('div', {
            children: [
              jsx('h1', { className: 'forx-pub-title', children: '社区发布中心 (Community Publisher)' }),
              jsx('p', {
                className: 'forx-pub-subtitle',
                children: '在客户端对本地自研插件或技能进行全自动合规扫描，一键向官方目录发起 PR 提交发布，供全平台用户使用。',
              }),
            ],
          }),
        ],
      }),

      // Auth Banner
      jsx(AuthBanner, {
        ctx,
        auth,
        loadingAuth,
        onRefresh: fetchAuth,
        onAuthUpdated: (nextAuth) => setAuth(nextAuth),
        inputRef: tokenInputRef,
      }),

      // Step Bar
      jsx(StepBar, {
        step,
        setStep,
        canOpenStep2: Boolean(checkResult?.ok),
      }),

      // Step 1: Target Configuration
      step === 1 &&
        jsxs('div', {
          className: 'forx-pub-section',
          children: [
            jsx(SegmentedControl, {
              value: targetType,
              onChange: (next) => {
                setTargetType(next)
                setCheckResult(null)
                setCheckError('')
                setPubResult(null)
                setPubError('')
              },
              options: [
                { id: 'plugin', label: '插件 (Plugin)' },
                { id: 'skill', label: '技能 (Skill)', icon: icons.Zap },
              ],
            }),

            jsxs('div', {
              className: 'forx-pub-card',
              children: [
                jsxs('div', {
                  className: 'forx-pub-field',
                  children: [
                    jsx('label', { className: 'forx-pub-label', children: '本地代码目录路径 (Path)' }),
                    jsxs('div', {
                      className: 'forx-pub-path-row',
                      children: [
                        jsx(Input, {
                          type: 'text',
                          placeholder:
                            targetType === 'plugin'
                              ? '例如: ./plugins/my-plugin 或 D:/dev/my-tool'
                              : '例如: ./skills/my-skill 或 D:/dev/my-skill',
                          value: targetPath,
                          onChange: (e) => {
                            setTargetPath(e.target.value)
                            if (checkError) setCheckError('')
                          },
                          onKeyDown: (e) => {
                            if (isSubmitEnter(e) && targetPath.trim() && !checkLoading) {
                              e.preventDefault()
                              void handleRunCheck()
                            }
                          },
                        }),
                        jsxs(Button, {
                          variant: 'secondary',
                          size: 'sm',
                          type: 'button',
                          onClick: handlePickDirectory,
                          children: [
                            jsx(icons.FolderOpen, { className: 'size-3.5' }),
                            '选择目录',
                          ],
                        }),
                      ],
                    }),
                    jsxs('p', {
                      className: 'forx-pub-hint',
                      children: [
                        '需包含有效的 ',
                        jsx('code', {
                          className: 'forx-pub-code',
                          children: targetType === 'plugin' ? 'plugin.yaml' : 'SKILL.md',
                        }),
                        targetType === 'plugin' ? ' 清单文件。' : ' 文档文件。',
                      ],
                    }),
                  ],
                }),

                targetType === 'plugin' &&
                  jsxs('div', {
                    className: 'forx-pub-grid-2',
                    children: [
                      jsxs('div', {
                        className: 'forx-pub-field',
                        children: [
                          jsx('label', { className: 'forx-pub-label', children: '分类目录 (Shelf Category)' }),
                          jsxs(Select, {
                            value: category,
                            onValueChange: setCategory,
                            children: [
                              jsx(SelectTrigger, {
                                children: jsx(SelectValue, { placeholder: '选择分类' }),
                              }),
                              jsx(SelectContent, {
                                children: CATEGORIES.map((c) =>
                                  jsx(SelectItem, { value: c.id, children: c.label }, c.id)
                                ),
                              }),
                            ],
                          }),
                        ],
                      }),
                      jsxs('div', {
                        className: 'forx-pub-field',
                        children: [
                          jsx('label', { className: 'forx-pub-label', children: '维护者标识 (Maintainer ID)' }),
                          jsx(Input, {
                            type: 'text',
                            placeholder: auth?.username ? `默认 @${auth.username}` : '你的 GitHub 账号或组织名称',
                            value: maintainer,
                            onChange: (e) => setMaintainer(e.target.value),
                          }),
                        ],
                      }),
                    ],
                  }),

                checkError &&
                  jsxs('div', {
                    className: 'forx-pub-alert',
                    'data-tone': 'error',
                    children: [
                      jsx('div', { style: { fontWeight: 600 }, children: checkError }),
                      failureItems.length > 0 &&
                        jsx('ul', {
                          className: 'forx-pub-checklist',
                          children: failureItems.map((msg, i) =>
                            jsxs(
                              'li',
                              {
                                className: 'forx-pub-check-item',
                                children: [
                                  jsx('span', { className: 'forx-pub-check-dot', 'data-ok': 'false', children: '!' }),
                                  jsx('span', { style: { color: 'inherit' }, children: msg }),
                                ],
                              },
                              `fail-${i}`
                            )
                          ),
                        }),
                    ],
                  }),

                checkResult &&
                  !checkResult.ok &&
                  (failureChecks.length > 0 || (checkResult.findings || []).length > 0) &&
                  jsxs('div', {
                    className: 'forx-pub-card',
                    style: { padding: '12px 14px', gap: '10px' },
                    children: [
                      jsx('div', { className: 'forx-pub-label', children: '体检明细' }),
                      failureChecks.length > 0 &&
                        jsx('ul', {
                          className: 'forx-pub-checklist',
                          children: failureChecks.map((item, i) =>
                            jsxs(
                              'li',
                              {
                                className: 'forx-pub-check-item',
                                children: [
                                  jsx('span', {
                                    className: 'forx-pub-check-dot',
                                    'data-ok': item.ok ? 'true' : 'false',
                                    children: item.ok ? '✓' : '✕',
                                  }),
                                  jsxs('span', {
                                    children: [
                                      jsx('strong', { children: item.name }),
                                      item.detail ? ` — ${item.detail}` : '',
                                    ],
                                  }),
                                ],
                              },
                              `chk-${i}`
                            )
                          ),
                        }),
                      (checkResult.findings || []).length > 0 &&
                        jsx('ul', {
                          className: 'forx-pub-checklist',
                          children: checkResult.findings.map((f, i) =>
                            jsxs(
                              'li',
                              {
                                className: 'forx-pub-check-item',
                                children: [
                                  jsx('span', { className: 'forx-pub-check-dot', 'data-ok': 'false', children: '!' }),
                                  jsx('span', {
                                    children: `[${f.severity || 'high'}] ${f.description}${f.file ? ` (${f.file}:${f.line || 0})` : ''}`,
                                  }),
                                ],
                              },
                              `find-${i}`
                            )
                          ),
                        }),
                    ],
                  }),

                jsxs('div', {
                  className: 'forx-pub-footer',
                  children: [
                    jsx('span', {
                      className: 'forx-pub-hint',
                      children: '第一步仅对本地目录进行静态与沙箱校验，不产生任何网络变更。',
                    }),
                    jsxs(Button, {
                      variant: 'default',
                      size: 'sm',
                      onClick: handleRunCheck,
                      disabled: checkLoading || !targetPath.trim(),
                      children: [
                        checkLoading ? '正在全面体检…' : '开始合规体检',
                        !checkLoading && jsx(icons.ChevronRight, { className: 'size-3.5' }),
                      ],
                    }),
                  ],
                }),
              ],
            }),
          ],
        }),

      // Step 2: Audit & Validation Results
      step === 2 &&
        checkResult &&
        jsxs('div', {
          className: 'forx-pub-section',
          children: [
            // Summary Card
            jsxs('div', {
              className: 'forx-pub-card',
              'data-tone': 'ok',
              children: [
                jsxs('div', {
                  style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '10px', flexWrap: 'wrap' },
                  children: [
                    jsxs('div', {
                      style: { display: 'flex', alignItems: 'center', gap: '8px' },
                      children: [
                        jsx(icons.CheckCircle2, { className: 'size-4', style: { color: '#10b981' } }),
                        jsx('h3', {
                          style: { margin: 0, fontSize: '14px', fontWeight: 700 },
                          children: '体检与安全审计全部通过',
                        }),
                      ],
                    }),
                    jsxs('div', {
                      style: { display: 'flex', alignItems: 'center', gap: '6px' },
                      children: [
                        jsx(Badge, {
                          variant: 'success',
                          children:
                            targetType === 'plugin'
                              ? `${checkResult.name} (v${checkResult.version || '0.1.0'})`
                              : `${checkResult.name} · ${String(checkResult.verdict || 'safe').toUpperCase()}`,
                        }),
                      ],
                    }),
                  ],
                }),
                jsx('p', {
                  style: { margin: 0, fontSize: '12px', color: 'var(--ui-text-secondary)', lineHeight: 1.5 },
                  children: checkResult.description || '无简要描述',
                }),
                (checkResult.validation?.checks || []).length > 0 &&
                  jsx('div', {
                    style: { display: 'flex', flexWrap: 'wrap', gap: '6px' },
                    children: checkResult.validation.checks.map((c, idx) =>
                      jsx(
                        Badge,
                        {
                          variant: c.ok ? 'outline' : 'warn',
                          children: `${c.ok ? '✓' : '!'} ${c.name}`,
                        },
                        `pass-chk-${idx}`
                      )
                    ),
                  }),
              ],
            }),

            // Warnings if any
            pluginWarnings.length > 0 &&
              jsxs('div', {
                className: 'forx-pub-alert',
                'data-tone': 'warn',
                children: [
                  jsx('div', { style: { fontWeight: 600 }, children: '注意事项' }),
                  ...pluginWarnings.map((w, i) => jsx('div', { children: `• ${w}` }, `warn-${i}`)),
                ],
              }),

            // Skill findings if caution
            targetType === 'skill' &&
              (checkResult.findings || []).length > 0 &&
              jsxs('div', {
                className: 'forx-pub-card',
                'data-tone': 'warn',
                children: [
                  jsx('div', { className: 'forx-pub-label', children: `安全扫描提示 (${checkResult.findings.length} 项非致命发现)` }),
                  jsx('ul', {
                    className: 'forx-pub-checklist',
                    children: checkResult.findings.map((f, i) =>
                      jsxs(
                        'li',
                        {
                          className: 'forx-pub-check-item',
                          children: [
                            jsx('span', { className: 'forx-pub-check-dot', 'data-ok': 'false', children: '!' }),
                            jsx('span', { children: `[${f.severity || 'info'}] ${f.description}` }),
                          ],
                        },
                        `sf-${i}`
                      )
                    ),
                  }),
                ],
              }),

            // Git Info Card (For Plugin)
            targetType === 'plugin' &&
              jsxs('div', {
                className: 'forx-pub-card',
                children: [
                  jsx('div', { className: 'forx-pub-label', children: 'Git 仓库与 Commit SHA 锁定' }),
                  jsxs('div', {
                    className: 'forx-pub-grid-2',
                    children: [
                      jsxs('div', {
                        className: 'forx-pub-field',
                        children: [
                          jsx('label', { className: 'forx-pub-hint', children: '公开 Git 仓库地址' }),
                          jsx(Input, {
                            type: 'text',
                            value: gitUrl,
                            onChange: (e) => setGitUrl(e.target.value),
                            placeholder: 'https://github.com/owner/repo',
                          }),
                        ],
                      }),
                      jsxs('div', {
                        className: 'forx-pub-field',
                        children: [
                          jsx('label', { className: 'forx-pub-hint', children: '锁定 40 位 Commit SHA' }),
                          jsx(Input, {
                            type: 'text',
                            value: commitSha,
                            onChange: (e) => setCommitSha(e.target.value),
                            placeholder: '40位十六进制 Hash',
                          }),
                        ],
                      }),
                    ],
                  }),
                  checkResult.git?.is_dirty &&
                    jsx('div', {
                      className: 'forx-pub-alert',
                      'data-tone': 'warn',
                      children: '检测到本地工作区有未提交代码。正式发布前请确保最新改动已提交并推送到 GitHub 远程仓库。',
                    }),
                ],
              }),

            // Live YAML Preview
            liveYamlPreview &&
              jsxs('div', {
                className: 'forx-pub-card',
                children: [
                  jsxs('div', {
                    style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px' },
                    children: [
                      jsx('div', {
                        className: 'forx-pub-label',
                        children: `生成的 plugin-catalog/${checkResult.name}.yaml 清单预览`,
                      }),
                      jsx(CopyButton, {
                        text: liveYamlPreview,
                        appearance: 'button',
                        buttonSize: 'xs',
                        buttonVariant: 'ghost',
                        label: '复制 YAML',
                      }),
                    ],
                  }),
                  jsx('pre', {
                    className: 'forx-pub-pre',
                    children: liveYamlPreview,
                  }),
                ],
              }),

            // Dry-Run Preview Result
            pubResult?.dry_run &&
              jsxs('div', {
                className: 'forx-pub-card',
                'data-tone': 'ok',
                children: [
                  jsxs('div', {
                    style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px' },
                    children: [
                      jsx('div', { className: 'forx-pub-label', children: '预演模拟 (Dry-Run) 通过' }),
                      jsx(Badge, { variant: 'success', children: pubResult.target_repo || 'xtcamille/hermes-forx' }),
                    ],
                  }),
                  jsx('p', {
                    className: 'forx-pub-hint',
                    style: { color: 'var(--ui-text-secondary)' },
                    children: pubResult.message || '所有发布前置校验已通过，未向 GitHub 发起真实 PR。',
                  }),
                  pubResult.catalog_entry_path &&
                    jsxs('div', {
                      style: { fontSize: '12px', color: 'var(--ui-text-secondary)' },
                      children: [
                        '目标条目路径：',
                        jsx('code', { className: 'forx-pub-code', children: pubResult.catalog_entry_path }),
                      ],
                    }),
                  Array.isArray(pubResult.files_to_upload) &&
                    pubResult.files_to_upload.length > 0 &&
                    jsxs('div', {
                      style: { fontSize: '12px', color: 'var(--ui-text-secondary)' },
                      children: [
                        `待上传文件 (${pubResult.files_to_upload.length} 个)：`,
                        jsx('pre', {
                          className: 'forx-pub-pre',
                          style: { marginTop: '6px' },
                          children: pubResult.files_to_upload.join('\n'),
                        }),
                      ],
                    }),
                ],
              }),

            pubError &&
              jsx('div', {
                className: 'forx-pub-alert',
                'data-tone': 'error',
                children: pubError,
              }),

            // Action Buttons
            jsxs('div', {
              className: 'forx-pub-footer',
              children: [
                jsxs(Button, {
                  variant: 'secondary',
                  size: 'sm',
                  onClick: () => setStep(1),
                  children: [
                    jsx(icons.ChevronLeft, { className: 'size-3.5' }),
                    '返回修改配置',
                  ],
                }),
                jsxs('div', {
                  className: 'forx-pub-footer-actions',
                  children: [
                    !auth?.authenticated &&
                      jsx(Button, {
                        variant: 'text',
                        size: 'xs',
                        onClick: focusAuthInput,
                        children: '需先完成上方 GitHub 授权 ↑',
                      }),
                    jsx(Button, {
                      variant: 'secondary',
                      size: 'sm',
                      onClick: () => handlePublish(true),
                      disabled: pubLoading,
                      children: pubLoading ? '正在预演…' : '预演模拟 (Dry-Run)',
                    }),
                    jsxs(Button, {
                      variant: 'default',
                      size: 'sm',
                      onClick: () => handlePublish(false),
                      disabled: pubLoading || !auth?.authenticated,
                      children: [
                        jsx(icons.Upload, { className: 'size-3.5' }),
                        pubLoading ? '正在创建 Pull Request…' : '正式发起 PR 发布',
                      ],
                    }),
                  ],
                }),
              ],
            }),
          ],
        }),

      // Step 3: Success Result
      step === 3 &&
        pubResult &&
        jsxs('div', {
          className: 'forx-pub-section',
          children: [
            jsxs('div', {
              className: 'forx-pub-card forx-pub-center-hero',
              'data-tone': 'ok',
              children: [
                jsx(icons.CheckCircle2, { className: 'size-10', style: { color: '#10b981' } }),
                jsx('h2', {
                  style: { margin: 0, fontSize: '18px', fontWeight: 700 },
                  children: 'Pull Request 已成功创建！',
                }),
                jsx('p', {
                  style: { margin: 0, fontSize: '12.5px', color: 'var(--ui-text-secondary)', maxWidth: '32rem' },
                  children: `已自动 Fork 并向官方仓库发起 Pull Request${pubResult.pr_number ? ` (#${pubResult.pr_number})` : ''}。`,
                }),
                pubResult.pr_url &&
                  jsxs(Button, {
                    variant: 'default',
                    size: 'sm',
                    onClick: () => openExternalUrl(ctx, pubResult.pr_url),
                    children: [
                      jsx(icons.ExternalLink, { className: 'size-3.5' }),
                      '在 GitHub 查看 Pull Request',
                    ],
                  }),
              ],
            }),

            jsxs('div', {
              className: 'forx-pub-card',
              children: [
                jsx('div', { className: 'forx-pub-label', children: '全网分发与生效机制' }),
                jsx('div', { className: 'forx-pub-hint', style: { color: 'var(--ui-text-secondary)' }, children: '1. 官方 CI 正在对该 PR 运行沙箱与规范测试（validate_plugin_catalog）；' }),
                jsx('div', { className: 'forx-pub-hint', style: { color: 'var(--ui-text-secondary)' }, children: '2. 维护者审核并合并后，全网 /api/plugin-catalog.json 将自动更新；' }),
                jsxs('div', {
                  style: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap', fontSize: '12px', color: 'var(--ui-text-secondary)' },
                  children: [
                    jsx('span', { children: '3. 随后全平台用户即可直接运行安装：' }),
                    jsx('code', {
                      className: 'forx-pub-code',
                      children: targetType === 'plugin' ? `forx plugins install ${pubResult.name}` : `forx skills install ${pubResult.name}`,
                    }),
                    jsx(CopyButton, {
                      text: targetType === 'plugin' ? `forx plugins install ${pubResult.name}` : `forx skills install ${pubResult.name}`,
                      appearance: 'icon',
                      buttonSize: 'icon-xs',
                      title: '复制安装命令',
                    }),
                  ],
                }),
              ],
            }),

            jsx('div', {
              style: { display: 'flex', justifyContent: 'center', paddingTop: '6px' },
              children: jsx(Button, {
                variant: 'secondary',
                size: 'sm',
                onClick: () => {
                  setStep(1)
                  setCheckResult(null)
                  setPubResult(null)
                  setCheckError('')
                  setPubError('')
                },
                children: '发布其他插件或技能',
              }),
            }),
          ],
        }),
    ],
  })
}

// ─────────────────────────────────────────────────────────────
// COMPONENT: Right Pane Companion
// ─────────────────────────────────────────────────────────────
function PublisherPane() {
  return jsxs('div', {
    className: 'forx-pub-pane',
    children: [
      jsxs('div', {
        className: 'forx-pub-pane-title',
        children: [jsx(icons.Upload, { className: 'size-4' }), jsx('span', { children: '发布助手 (Publisher)' })],
      }),
      jsx('p', {
        className: 'forx-pub-hint',
        style: { fontSize: '12px', color: 'var(--ui-text-secondary)' },
        children: '一键对本地自研插件或技能进行合规体检、配置 GitHub 授权并提交 PR 到全平台公共库。',
      }),
      jsxs(Button, {
        variant: 'default',
        size: 'sm',
        style: { width: '100%' },
        onClick: () => host.navigate('/publish'),
        children: [
          '打开全屏发布工作台',
          jsx(icons.ArrowUpRight, { className: 'size-3.5' }),
        ],
      }),
      jsxs('div', {
        style: { paddingTop: '12px', borderTop: '1px solid var(--ui-stroke-secondary)', display: 'flex', flexDirection: 'column', gap: '8px' },
        children: [
          jsx('div', { className: 'forx-pub-label', children: '常用终端命令' }),
          jsx('pre', { className: 'forx-pub-pre', children: 'hermes publish check <path>' }),
          jsx('pre', { className: 'forx-pub-pre', children: 'hermes publish plugin <path>' }),
          jsx('pre', { className: 'forx-pub-pre', children: 'hermes publish skill <path>' }),
        ],
      }),
    ],
  })
}

// ─────────────────────────────────────────────────────────────
// Hermes Desktop Plugin Registration Export
// ─────────────────────────────────────────────────────────────
export default {
  id: PLUGIN_ID,
  name: '社区发布中心 (Community Publisher)',
  defaultEnabled: true,
  register(ctx) {
    const style = document.createElement('style')
    style.textContent = CSS
    document.head.append(style)
    ctx.onDispose(() => style.remove())

    // 1. Full Page Route: /publish
    ctx.register({
      id: 'route',
      area: ROUTES_AREA,
      data: { path: '/publish' },
      render: () => jsx(PublisherView, { ctx }),
    })

    // 2. Sidebar Navigation Row
    ctx.register({
      id: 'nav',
      area: SIDEBAR_NAV_AREA,
      data: { path: '/publish', label: '发布与共享', codicon: 'cloud-upload' },
    })

    // 3. Right Companion Pane
    ctx.register({
      id: 'pane',
      area: PANES_AREA,
      title: '社区发布中心',
      data: { placement: 'right', width: '320px' },
      render: () => jsx(PublisherPane),
    })

    // 4. Command Palette (⌘K / Ctrl+K)
    ctx.registerMany([
      {
        id: 'palette-open-publish',
        area: PALETTE_AREA,
        data: {
          id: 'publisher.open',
          label: 'Open Community Publisher (打开社区发布中心)',
          keywords: ['publish', 'share', 'plugin', 'skill', 'marketplace', '发布', '提交', '分享'],
          run: () => host.navigate('/publish'),
        },
      },
    ])
  },
}
