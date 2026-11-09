import {
  host,
  useValue,
  haptic,
  cn,
  Button,
  Badge,
  PANES_AREA,
  ROUTES_AREA,
  SIDEBAR_NAV_AREA,
  PALETTE_AREA,
} from '@hermes/plugin-sdk'
import { jsx, jsxs } from 'react/jsx-runtime'
import React, { useState, useEffect, useCallback } from 'react'

const PLUGIN_ID = 'forx-publisher'

// ─────────────────────────────────────────────────────────────
// COMPONENT: GitHub Auth Status Banner
// ─────────────────────────────────────────────────────────────
function AuthBanner({ auth, onRefresh }) {
  const isAuthed = auth?.authenticated

  return jsxs('div', {
    className: cn(
      'p-4 rounded-xl border mb-6 flex flex-col md:flex-row items-start md:items-center justify-between gap-3',
      isAuthed
        ? 'bg-emerald-500/5 border-emerald-500/20 text-emerald-800 dark:text-emerald-300'
        : 'bg-amber-500/5 border-amber-500/20 text-amber-800 dark:text-amber-300'
    ),
    children: [
      jsxs('div', {
        className: 'flex items-center gap-3',
        children: [
          jsx('div', {
            className: cn(
              'w-8 h-8 rounded-full flex items-center justify-center font-bold text-sm shrink-0',
              isAuthed ? 'bg-emerald-500/20 text-emerald-600 dark:text-emerald-400' : 'bg-amber-500/20 text-amber-600 dark:text-amber-400'
            ),
            children: isAuthed ? '✓' : '!',
          }),
          jsxs('div', {
            children: [
              jsxs('div', {
                className: 'font-semibold text-sm flex items-center gap-2',
                children: [
                  jsx('span', { children: isAuthed ? 'GitHub 凭据已就绪' : '未检测到 GitHub 认证' }),
                  isAuthed && auth.username
                    ? jsx('span', {
                        className: 'px-2 py-0.5 text-xs rounded-full bg-emerald-500/20 font-mono',
                        children: `@${auth.username} (${auth.method || 'pat'})`,
                      })
                    : null,
                ],
              }),
              jsx('div', {
                className: 'text-xs opacity-80 mt-0.5',
                children: isAuthed
                  ? '已具备自动 Fork 目标仓库并向公共库发起 Pull Request 的权限。'
                  : '发布需要 GitHub 授权。在终端运行 `gh auth login` 或在 `~/.hermes/.env` 中配置 `GITHUB_TOKEN=ghp_...`。',
              }),
            ],
          }),
        ],
      }),
      jsx(Button, {
        variant: 'secondary',
        size: 'sm',
        onClick: onRefresh,
        className: 'text-xs shrink-0 self-end md:self-auto',
        children: '刷新状态',
      }),
    ],
  })
}

// ─────────────────────────────────────────────────────────────
// COMPONENT: Step Indicator
// ─────────────────────────────────────────────────────────────
function StepBar({ step, setStep }) {
  const steps = [
    { num: 1, label: '1. 目标配置' },
    { num: 2, label: '2. 合规与体检' },
    { num: 3, label: '3. 提交与发布' },
  ]

  return jsx('div', {
    className: 'flex items-center justify-between border-b border-[var(--ui-stroke-secondary,rgba(0,0,0,0.08))] pb-4 mb-6',
    children: steps.map((s) => {
      const active = step === s.num
      const done = step > s.num
      return jsxs(
        'button',
        {
          key: s.num,
          type: 'button',
          onClick: () => (done ? setStep(s.num) : null),
          className: cn(
            'flex items-center gap-2 text-xs font-medium transition-colors',
            active && 'text-blue-600 dark:text-blue-400 font-semibold',
            done && 'text-emerald-600 dark:text-emerald-400 cursor-pointer',
            !active && !done && 'text-neutral-400 dark:text-neutral-500'
          ),
          children: [
            jsx('span', {
              className: cn(
                'w-5 h-5 rounded-full flex items-center justify-center text-[11px]',
                active && 'bg-blue-600 text-white',
                done && 'bg-emerald-600 text-white',
                !active && !done && 'bg-neutral-200 dark:bg-neutral-800 text-neutral-500'
              ),
              children: done ? '✓' : s.num,
            }),
            jsx('span', { children: s.label }),
          ],
        },
        s.num
      )
    }),
  })
}

// ─────────────────────────────────────────────────────────────
// COMPONENT: Publisher Main View (Route /publish)
// ─────────────────────────────────────────────────────────────
function PublisherView({ ctx }) {
  const profile = useValue(host.state.profile)

  const [targetType, setTargetType] = useState('plugin') // 'plugin' | 'skill'
  const [targetPath, setTargetPath] = useState('')
  const [category, setCategory] = useState('tools')
  const [gitUrl, setGitUrl] = useState('')
  const [commitSha, setCommitSha] = useState('')
  const [maintainer, setMaintainer] = useState('')
  const [step, setStep] = useState(1)

  // Auth state
  const [auth, setAuth] = useState(null)
  const [loadingAuth, setLoadingAuth] = useState(false)

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
      .catch((err) => setAuth({ authenticated: false, error: err.message }))
      .finally(() => setLoadingAuth(false))
  }, [ctx])

  useEffect(() => {
    fetchAuth()
  }, [fetchAuth])

  // Step 1 -> Step 2: Run Check
  const handleRunCheck = async () => {
    if (!targetPath.trim()) {
      setCheckError('请先输入本地插件或技能的目录路径。')
      return
    }

    setCheckLoading(true)
    setCheckError('')
    setCheckResult(null)

    try {
      const res = await ctx.rest('/check', {
        method: 'POST',
        body: { path: targetPath.trim(), target_type: targetType },
      })
      setCheckResult(res)
      if (res.ok) {
        if (res.git?.remote_url && !gitUrl) setGitUrl(res.git.remote_url)
        if (res.git?.commit_sha && !commitSha) setCommitSha(res.git.commit_sha)
        if (res.maintainer && !maintainer) setMaintainer(res.maintainer)
        if (res.category) setCategory(res.category)
        haptic('success')
        setStep(2)
      } else {
        haptic('error')
        setCheckError(res.error || '检查未通过，请根据下方问题排查。')
      }
    } catch (e) {
      setCheckError(e.message || '网络或接口异常')
    } finally {
      setCheckLoading(false)
    }
  }

  // Step 2 -> Step 3: Run Publish
  const handlePublish = async (dryRun = false) => {
    setPubLoading(true)
    setPubError('')
    setPubResult(null)

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
      setPubError(e.message || '发布请求发生异常')
    } finally {
      setPubLoading(false)
    }
  }

  return jsxs('div', {
    className: 'max-w-4xl mx-auto px-6 py-8 flex flex-col h-full overflow-y-auto text-[var(--ui-text-primary,#0f172a)] dark:text-[var(--ui-text-primary,#f8fafc)]',
    children: [
      // Header
      jsxs('div', {
        className: 'mb-6',
        children: [
          jsxs('div', {
            className: 'flex items-center gap-3',
            children: [
              jsx('div', {
                className: 'w-10 h-10 rounded-xl bg-blue-600/10 text-blue-600 dark:text-blue-400 flex items-center justify-center text-xl font-bold',
                children: '🚀',
              }),
              jsxs('div', {
                children: [
                  jsx('h1', { className: 'text-xl font-bold tracking-tight', children: '社区发布中心 (Community Publisher)' }),
                  jsx('p', {
                    className: 'text-xs text-[var(--ui-text-secondary,#64748b)] dark:text-[var(--ui-text-secondary,#94a3b8)] mt-0.5',
                    children: '在客户端对本地自研插件或技能进行全自动合规扫描，一键向官方目录发起 PR 提交发布，供全平台用户使用。',
                  }),
                ],
              }),
            ],
          }),
        ],
      }),

      // Auth Banner
      jsx(AuthBanner, { auth, onRefresh: fetchAuth }),

      // Step Bar
      jsx(StepBar, { step, setStep }),

      // Step 1: Target Configuration
      step === 1 &&
        jsxs('div', {
          className: 'space-y-6 animate-in fade-in duration-200',
          children: [
            // Target Type Selector Tabs
            jsxs('div', {
              className: 'flex gap-2 p-1 bg-neutral-100 dark:bg-neutral-800/60 rounded-lg max-w-sm',
              children: [
                jsx('button', {
                  type: 'button',
                  onClick: () => {
                    setTargetType('plugin')
                    setCheckResult(null)
                  },
                  className: cn(
                    'flex-1 py-1.5 text-xs font-semibold rounded-md transition-all',
                    targetType === 'plugin' ? 'bg-white dark:bg-neutral-900 shadow-sm text-blue-600 dark:text-blue-400' : 'text-neutral-500 hover:text-neutral-800'
                  ),
                  children: '🔌 插件 (Plugin)',
                }),
                jsx('button', {
                  type: 'button',
                  onClick: () => {
                    setTargetType('skill')
                    setCheckResult(null)
                  },
                  className: cn(
                    'flex-1 py-1.5 text-xs font-semibold rounded-md transition-all',
                    targetType === 'skill' ? 'bg-white dark:bg-neutral-900 shadow-sm text-blue-600 dark:text-blue-400' : 'text-neutral-500 hover:text-neutral-800'
                  ),
                  children: '⚡ 技能 (Skill)',
                }),
              ],
            }),

            // Path Input Form
            jsxs('div', {
              className: 'p-5 rounded-xl border border-[var(--ui-stroke-secondary,rgba(0,0,0,0.08))] dark:border-white/10 bg-[var(--ui-bg-surface,#ffffff)] dark:bg-white/[0.02] space-y-4',
              children: [
                jsxs('div', {
                  children: [
                    jsx('label', { className: 'block text-xs font-semibold mb-1.5', children: '本地代码目录路径 (Path)' }),
                    jsx('input', {
                      type: 'text',
                      placeholder: targetType === 'plugin' ? '例如: ./plugins/my-plugin 或 D:/dev/my-tool' : '例如: ./skills/my-skill 或 D:/dev/my-skill',
                      value: targetPath,
                      onChange: (e) => setTargetPath(e.target.value),
                      className: 'w-full px-3 py-2 text-xs rounded-lg border border-neutral-300 dark:border-neutral-700 bg-transparent focus:outline-none focus:ring-2 focus:ring-blue-500/30',
                    }),
                    jsx('p', {
                      className: 'text-[11px] text-neutral-400 mt-1',
                      children: targetType === 'plugin' ? '需包含有效的 plugin.yaml 清单文件。' : '需包含有效的 SKILL.md 文档文件。',
                    }),
                  ],
                }),

                targetType === 'plugin' &&
                  jsxs('div', {
                    className: 'grid grid-cols-1 md:grid-cols-2 gap-4 pt-2',
                    children: [
                      jsxs('div', {
                        children: [
                          jsx('label', { className: 'block text-xs font-semibold mb-1.5', children: '分类目录 (Shelf Category)' }),
                          jsx('select', {
                            value: category,
                            onChange: (e) => setCategory(e.target.value),
                            className: 'w-full px-3 py-2 text-xs rounded-lg border border-neutral-300 dark:border-neutral-700 bg-transparent focus:outline-none focus:ring-2 focus:ring-blue-500/30',
                            children: ['tools', 'desktop', 'web', 'automation', 'memory', 'models', 'voice', 'platform', 'general'].map((c) =>
                              jsx('option', { value: c, children: c }, c)
                            ),
                          }),
                        ],
                      }),
                      jsxs('div', {
                        children: [
                          jsx('label', { className: 'block text-xs font-semibold mb-1.5', children: '维护者标识 (Maintainer ID)' }),
                          jsx('input', {
                            type: 'text',
                            placeholder: '你的 GitHub 账号或组织名称',
                            value: maintainer,
                            onChange: (e) => setMaintainer(e.target.value),
                            className: 'w-full px-3 py-2 text-xs rounded-lg border border-neutral-300 dark:border-neutral-700 bg-transparent focus:outline-none focus:ring-2 focus:ring-blue-500/30',
                          }),
                        ],
                      }),
                    ],
                  }),

                checkError &&
                  jsx('div', {
                    className: 'p-3 rounded-lg bg-red-500/10 border border-red-500/20 text-red-600 dark:text-red-400 text-xs',
                    children: checkError,
                  }),

                jsxs('div', {
                  className: 'flex items-center justify-between pt-2',
                  children: [
                    jsx('span', { className: 'text-xs text-neutral-400', children: '第一步将对目录进行本地静态和沙箱校验，不产生网络变更。' }),
                    jsx(Button, {
                      variant: 'primary',
                      size: 'sm',
                      onClick: handleRunCheck,
                      disabled: checkLoading || !targetPath.trim(),
                      children: checkLoading ? '正在全面体检...' : '开始合规体检 ➔',
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
          className: 'space-y-6 animate-in fade-in duration-200',
          children: [
            // Summary Card
            jsxs('div', {
              className: 'p-5 rounded-xl border border-emerald-500/20 bg-emerald-500/5 space-y-3',
              children: [
                jsxs('div', {
                  className: 'flex items-center justify-between',
                  children: [
                    jsxs('div', {
                      className: 'flex items-center gap-2',
                      children: [
                        jsx('span', { className: 'text-lg', children: '🎉' }),
                        jsx('h3', { className: 'text-sm font-bold text-emerald-800 dark:text-emerald-300', children: '体检与安全审计全部通过！' }),
                      ],
                    }),
                    jsx('span', {
                      className: 'px-2 py-0.5 text-xs rounded bg-emerald-500/20 text-emerald-700 dark:text-emerald-300 font-mono',
                      children: `${checkResult.name} (v${checkResult.version || '0.1.0'})`,
                    }),
                  ],
                }),
                jsx('p', { className: 'text-xs text-emerald-700/80 dark:text-emerald-400/80', children: checkResult.description || '无简要描述' }),
              ],
            }),

            // Git Info Card (For Plugin)
            targetType === 'plugin' &&
              checkResult.git &&
              jsxs('div', {
                className: 'p-5 rounded-xl border border-[var(--ui-stroke-secondary,rgba(0,0,0,0.08))] dark:border-white/10 bg-[var(--ui-bg-surface,#ffffff)] dark:bg-white/[0.02] space-y-4',
                children: [
                  jsx('h4', { className: 'text-xs font-semibold', children: 'Git 仓库与 Commit SHA 锁定' }),
                  jsxs('div', {
                    className: 'grid grid-cols-1 md:grid-cols-2 gap-4 text-xs',
                    children: [
                      jsxs('div', {
                        children: [
                          jsx('span', { className: 'text-neutral-400 block mb-1', children: '公开 Git 仓库地址' }),
                          jsx('input', {
                            type: 'text',
                            value: gitUrl,
                            onChange: (e) => setGitUrl(e.target.value),
                            placeholder: 'https://github.com/owner/repo',
                            className: 'w-full px-3 py-1.5 rounded-lg border border-neutral-300 dark:border-neutral-700 bg-transparent font-mono text-xs',
                          }),
                        ],
                      }),
                      jsxs('div', {
                        children: [
                          jsx('span', { className: 'text-neutral-400 block mb-1', children: '锁定 40 位 Commit SHA' }),
                          jsx('input', {
                            type: 'text',
                            value: commitSha,
                            onChange: (e) => setCommitSha(e.target.value),
                            placeholder: '40位十六进制 Hash',
                            className: 'w-full px-3 py-1.5 rounded-lg border border-neutral-300 dark:border-neutral-700 bg-transparent font-mono text-xs',
                          }),
                        ],
                      }),
                    ],
                  }),
                  checkResult.git.is_dirty &&
                    jsx('div', {
                      className: 'p-3 rounded-lg bg-amber-500/10 text-amber-700 dark:text-amber-300 text-xs',
                      children: '⚠️ 检测到本地工作区有未提交代码。正式发布前请确保最新改动已推送到 GitHub 远程仓库！',
                    }),
                ],
              }),

            // YAML Preview
            checkResult.catalog_yaml_preview &&
              jsxs('div', {
                className: 'p-5 rounded-xl border border-[var(--ui-stroke-secondary,rgba(0,0,0,0.08))] dark:border-white/10 bg-[var(--ui-bg-surface,#ffffff)] dark:bg-white/[0.02]',
                children: [
                  jsx('h4', { className: 'text-xs font-semibold mb-2', children: '生成的 plugin-catalog/*.yaml 清单预览' }),
                  jsx('pre', {
                    className: 'p-3 rounded-lg bg-neutral-900 text-neutral-100 font-mono text-[11px] overflow-x-auto leading-relaxed',
                    children: checkResult.catalog_yaml_preview,
                  }),
                ],
              }),

            pubError &&
              jsx('div', {
                className: 'p-3 rounded-lg bg-red-500/10 border border-red-500/20 text-red-600 dark:text-red-400 text-xs',
                children: pubError,
              }),

            // Action Buttons
            jsxs('div', {
              className: 'flex items-center justify-between pt-2',
              children: [
                jsx(Button, {
                  variant: 'secondary',
                  size: 'sm',
                  onClick: () => setStep(1),
                  children: '← 返回修改路径',
                }),
                jsxs('div', {
                  className: 'flex items-center gap-2',
                  children: [
                    jsx(Button, {
                      variant: 'secondary',
                      size: 'sm',
                      onClick: () => handlePublish(true),
                      disabled: pubLoading,
                      children: '预演模拟 (Dry-Run)',
                    }),
                    jsx(Button, {
                      variant: 'primary',
                      size: 'sm',
                      onClick: () => handlePublish(false),
                      disabled: pubLoading || !auth?.authenticated,
                      children: pubLoading ? '正在创建 Pull Request...' : '🚀 正式发起 PR 发布',
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
          className: 'space-y-6 animate-in fade-in duration-200',
          children: [
            jsxs('div', {
              className: 'p-6 rounded-xl border border-emerald-500/30 bg-emerald-500/10 text-center space-y-4',
              children: [
                jsx('div', { className: 'text-4xl', children: '🎉' }),
                jsx('h2', { className: 'text-lg font-bold text-emerald-800 dark:text-emerald-300', children: 'Pull Request 已成功创建！' }),
                jsx('p', {
                  className: 'text-xs text-neutral-600 dark:text-neutral-300 max-w-lg mx-auto',
                  children: `已自动 Fork 并向官方仓库发起 Pull Request (${pubResult.pr_number ? `#${pubResult.pr_number}` : ''})。`,
                }),
                pubResult.pr_url &&
                  jsx('div', {
                    className: 'pt-2',
                    children: jsx('a', {
                      href: pubResult.pr_url,
                      target: '_blank',
                      rel: 'noreferrer',
                      className: 'inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-blue-600 text-white text-xs font-semibold hover:bg-blue-700 transition-colors',
                      children: '在 GitHub 查看 Pull Request ↗',
                    }),
                  }),
              ],
            }),

            jsxs('div', {
              className: 'p-5 rounded-xl border border-[var(--ui-stroke-secondary,rgba(0,0,0,0.08))] dark:border-white/10 bg-[var(--ui-bg-surface,#ffffff)] dark:bg-white/[0.02] space-y-2 text-xs',
              children: [
                jsx('h4', { className: 'font-semibold mb-2', children: '全网分发与生效机制' }),
                jsx('div', { children: '1. 官方 CI 正在对该 PR 运行沙箱与规范测试（validate_plugin_catalog）；' }),
                jsx('div', { children: '2. 维护者审核并合并后，全网 /api/plugin-catalog.json 将自动更新；' }),
                jsxs('div', {
                  className: 'pt-2 flex items-center gap-2',
                  children: [
                    jsx('span', { children: '3. 随后全平台所有用户即可直接运行安装：' }),
                    jsx('code', {
                      className: 'px-2 py-0.5 rounded bg-neutral-200 dark:bg-neutral-800 font-mono text-blue-600 dark:text-blue-400',
                      children: targetType === 'plugin' ? `forx plugins install ${pubResult.name}` : `forx skills install ${pubResult.name}`,
                    }),
                  ],
                }),
              ],
            }),

            jsx('div', {
              className: 'flex justify-center pt-4',
              children: jsx(Button, {
                variant: 'secondary',
                size: 'sm',
                onClick: () => {
                  setStep(1)
                  setCheckResult(null)
                  setPubResult(null)
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
function PublisherPane({ ctx }) {
  return jsxs('div', {
    className: 'p-4 space-y-4 text-xs h-full overflow-y-auto',
    children: [
      jsxs('div', {
        className: 'flex items-center gap-2 font-semibold text-sm border-b pb-2',
        children: [jsx('span', { children: '🚀' }), jsx('span', { children: '发布助手 (Publisher)' })],
      }),
      jsx('p', {
        className: 'text-neutral-500 leading-relaxed',
        children: '一键将当前开发的插件或技能发布到全网，供所有用户搜索与安装使用。',
      }),
      jsx(Button, {
        variant: 'primary',
        size: 'sm',
        className: 'w-full',
        onClick: () => host.navigate('/publish'),
        children: '打开全屏发布工作台 ↗',
      }),
      jsxs('div', {
        className: 'pt-4 border-t space-y-2 text-neutral-400',
        children: [
          jsx('div', { className: 'font-semibold text-neutral-600 dark:text-neutral-300', children: '常用终端命令:' }),
          jsx('code', { className: 'block p-2 rounded bg-neutral-100 dark:bg-neutral-800 font-mono text-[11px]', children: 'hermes publish check <path>' }),
          jsx('code', { className: 'block p-2 rounded bg-neutral-100 dark:bg-neutral-800 font-mono text-[11px]', children: 'hermes publish plugin <path>' }),
          jsx('code', { className: 'block p-2 rounded bg-neutral-100 dark:bg-neutral-800 font-mono text-[11px]', children: 'hermes publish skill <path>' }),
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
      render: () => jsx(PublisherPane, { ctx }),
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
