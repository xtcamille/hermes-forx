import {
  host,
  useValue,
  useQuery,
  useQueryClient,
  haptic,
  cn,
  Button,
  Input,
  Badge,
  PANES_AREA,
  ROUTES_AREA,
  SIDEBAR_NAV_AREA,
  STATUSBAR_AREAS,
  PALETTE_AREA,
} from '@hermes/plugin-sdk'
import { jsx, jsxs } from 'react/jsx-runtime'
import React, { useState, useMemo } from 'react'

const PLUGIN_ID = 'forx-context'

function fmtTokens(tok) {
  if (tok == null) return '0'
  const n = Number(tok)
  if (n >= 1000000) return (n / 1000000).toFixed(2) + 'M'
  if (n >= 1000) return (n / 1000).toFixed(1) + 'k'
  return String(n)
}

function fmtMoney(usd) {
  const n = Number(usd || 0)
  if (n === 0) return '$0.00'
  if (n < 0.01) return '$' + n.toFixed(4)
  return '$' + n.toFixed(2)
}

function getStatusBadge(status) {
  if (status === 'safe') {
    return { label: '安全 Safe', color: '#10b981', bg: 'rgba(16, 185, 129, 0.15)' }
  }
  if (status === 'caution') {
    return { label: '警戒 Caution', color: '#f59e0b', bg: 'rgba(245, 158, 11, 0.15)' }
  }
  return { label: '临界 Critical', color: '#ef4444', bg: 'rgba(239, 68, 68, 0.15)' }
}

function getModelBrandBadge(modelName = '') {
  const m = modelName.toLowerCase()
  if (m.includes('qwen')) {
    return { label: '千问 Qwen', color: '#6366f1', bg: 'rgba(99, 102, 241, 0.12)' }
  }
  if (m.includes('glm')) {
    return { label: '智谱 GLM', color: '#06b6d4', bg: 'rgba(6, 182, 212, 0.12)' }
  }
  if (m.includes('deepseek')) {
    return { label: '深度求索 DeepSeek', color: '#3b82f6', bg: 'rgba(59, 130, 246, 0.12)' }
  }
  if (m.includes('claude')) {
    return { label: 'Claude', color: '#d97706', bg: 'rgba(217, 119, 6, 0.12)' }
  }
  if (m.includes('gpt')) {
    return { label: 'OpenAI GPT', color: '#10b981', bg: 'rgba(16, 185, 129, 0.12)' }
  }
  return { label: 'LLM', color: '#8b5cf6', bg: 'rgba(139, 92, 246, 0.12)' }
}

// ─────────────────────────────────────────────────────────────
// COMPONENT: Context Gauge (Circular Capacity)
// ─────────────────────────────────────────────────────────────
function ContextGauge({ pct = 0, activeTokens = 0, limit = 128000, status = 'safe', compactedTokens = 0 }) {
  const radius = 64
  const stroke = 10
  const normRadius = radius - stroke * 2
  const circ = 2 * Math.PI * normRadius
  const safePct = Math.min(Math.max(0, pct), 100)
  const strokeDashoffset = circ - (safePct / 100) * circ
  const badge = getStatusBadge(status)

  return jsxs('div', {
    className: 'flex flex-col items-center justify-center p-4 rounded-xl border border-[var(--ui-stroke-secondary,rgba(0,0,0,0.08))] dark:border-white/10 bg-[var(--ui-bg-surface,#f8fafc)] dark:bg-white/[0.02]',
    children: [
      jsxs('div', {
        className: 'relative flex items-center justify-center',
        children: [
          jsxs('svg', {
            height: radius * 2,
            width: radius * 2,
            className: 'rotate-[-90deg]',
            children: [
              // Track
              jsx('circle', {
                stroke: 'currentColor',
                className: 'text-neutral-200 dark:text-neutral-800',
                fill: 'transparent',
                strokeWidth: stroke,
                r: normRadius,
                cx: radius,
                cy: radius,
              }),
              // Progress
              jsx('circle', {
                stroke: badge.color,
                fill: 'transparent',
                strokeWidth: stroke,
                strokeDasharray: `${circ} ${circ}`,
                style: { strokeDashoffset, transition: 'stroke-dashoffset 0.6s ease' },
                strokeLinecap: 'round',
                r: normRadius,
                cx: radius,
                cy: radius,
              }),
            ],
          }),
          // Center Info
          jsxs('div', {
            className: 'absolute flex flex-col items-center justify-center text-center',
            children: [
              jsx('span', {
                className: 'text-xl font-bold font-mono tracking-tight text-[var(--ui-text-primary,#0f172a)] dark:text-white',
                children: `${pct}%`,
              }),
              jsx('span', {
                className: 'text-[10px] uppercase font-semibold px-1.5 py-0.5 rounded-full mt-0.5',
                style: { color: badge.color, backgroundColor: badge.bg },
                children: badge.label,
              }),
            ],
          }),
        ],
      }),
      // Text Summary Below
      jsxs('div', {
        className: 'mt-3 text-center',
        children: [
          jsxs('div', {
            className: 'text-xs text-[var(--ui-text-secondary,#475569)] dark:text-neutral-300 font-mono',
            children: [
              jsx('span', { className: 'font-semibold text-[var(--ui-text-primary,#0f172a)] dark:text-white', children: fmtTokens(activeTokens) }),
              jsx('span', { className: 'text-[var(--ui-text-tertiary,#94a3b8)] dark:text-neutral-500 mx-1', children: '/' }),
              jsx('span', { className: 'text-[var(--ui-text-secondary,#475569)] dark:text-neutral-400', children: `${fmtTokens(limit)} tokens` }),
            ],
          }),
          compactedTokens > 0 &&
            jsx('div', {
              className: 'text-[11px] text-[#10b981] mt-0.5',
              children: `⚡ 已压缩归档 ${fmtTokens(compactedTokens)} tokens`,
            }),
        ],
      }),
    ],
  })
}

// ─────────────────────────────────────────────────────────────
// COMPONENT: Context Breakdown Multi-Segment Progress Bar
// ─────────────────────────────────────────────────────────────
function BreakdownBar({ segments = [], activeTokens = 1 }) {
  if (!segments || segments.length === 0) return null

  return jsxs('div', {
    className: 'flex flex-col gap-2.5 p-3 rounded-lg border border-[var(--ui-stroke-secondary,rgba(0,0,0,0.08))] dark:border-white/10 bg-[var(--ui-bg-surface,#f8fafc)] dark:bg-white/[0.02]',
    children: [
      jsx('div', {
        className: 'text-xs font-semibold text-[var(--ui-text-primary,#0f172a)] dark:text-[var(--ui-text-secondary,#cbd5e1)] mb-1',
        children: '🧩 上下文组成分布 (Breakdown)',
      }),
      jsx('div', {
        className: 'w-full h-3.5 flex rounded-md overflow-hidden bg-neutral-200/80 dark:bg-black/40 p-0.5 gap-0.5',
        children: segments.map((seg) => {
          const pct = Math.max(1, Math.round((seg.tokens / Math.max(1, activeTokens)) * 100))
          return jsx(
            'div',
            {
              title: `${seg.label}: ${fmtTokens(seg.tokens)} (${pct}%)`,
              style: {
                width: `${pct}%`,
                backgroundColor: seg.color,
                borderRadius: '2px',
              },
            },
            seg.key
          )
        }),
      }),
      jsx('div', {
        className: 'flex flex-col gap-1.5 mt-1',
        children: segments.map((seg) => {
          const pct = ((seg.tokens / Math.max(1, activeTokens)) * 100).toFixed(1)
          return jsxs(
            'div',
            {
              className: 'flex items-center justify-between text-xs',
              children: [
                jsxs('div', {
                  className: 'flex items-center gap-1.5 truncate pr-2',
                  children: [
                    jsx('span', {
                      className: 'w-2 h-2 rounded-full shrink-0',
                      style: { backgroundColor: seg.color },
                    }),
                    jsx('span', {
                      className: 'text-[var(--ui-text-secondary,#475569)] dark:text-[var(--ui-text-secondary,#cbd5e1)] truncate',
                      children: seg.label,
                    }),
                  ],
                }),
                jsxs('div', {
                  className: 'font-mono text-right shrink-0',
                  children: [
                    jsx('span', { className: 'font-medium text-[var(--ui-text-primary,#0f172a)] dark:text-white', children: fmtTokens(seg.tokens) }),
                    jsx('span', { className: 'text-[var(--ui-text-tertiary,#94a3b8)] ml-1', children: `(${pct}%)` }),
                  ],
                }),
              ],
            },
            seg.key
          )
        }),
      }),
    ],
  })
}

// ─────────────────────────────────────────────────────────────
// COMPONENT: KPI Stat Cards
// ─────────────────────────────────────────────────────────────
function KpiCard({ title, value, subtext, icon, tag }) {
  return jsxs('div', {
    className: 'flex flex-col p-4 rounded-xl border border-[var(--ui-stroke-secondary,rgba(0,0,0,0.08))] dark:border-white/10 bg-[var(--ui-bg-surface,#ffffff)] dark:bg-white/[0.02] relative overflow-hidden shadow-sm',
    children: [
      jsxs('div', {
        className: 'flex items-center justify-between text-xs text-[var(--ui-text-secondary,#475569)] dark:text-[var(--ui-text-tertiary,#94a3b8)] mb-2',
        children: [
          jsx('span', { className: 'font-medium', children: title }),
          icon && jsx('span', { className: 'text-sm opacity-90', children: icon }),
        ],
      }),
      jsx('div', {
        className: 'text-2xl font-bold tracking-tight text-[var(--ui-text-primary,#0f172a)] dark:text-white mb-1 font-mono',
        children: value,
      }),
      jsxs('div', {
        className: 'flex items-center justify-between text-[11px] text-[var(--ui-text-secondary,#64748b)] dark:text-[var(--ui-text-tertiary,#94a3b8)] mt-0.5',
        children: [
          subtext && jsx('span', { children: subtext }),
          tag && (
            jsx('span', {
              className: 'px-1.5 py-0.5 rounded text-[10px] font-medium bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border border-emerald-500/20',
              children: tag,
            })
          ),
        ],
      }),
    ],
  })
}

// ─────────────────────────────────────────────────────────────
// COMPONENT: New API & Model Breakdown Section
// ─────────────────────────────────────────────────────────────
function ModelDistributionSection({ models = [], newApi = {}, providers = [] }) {
  const isNewApiActive = Boolean(newApi?.configured || newApi?.portal_url || providers.some(p => p.provider === 'latticecode'))

  return jsxs('div', {
    className: 'grid grid-cols-1 lg:grid-cols-3 gap-4',
    children: [
      // Left Col: ForX New API Provider Status Card
      jsxs('div', {
        className: 'flex flex-col p-5 rounded-xl border border-[var(--ui-stroke-secondary,rgba(0,0,0,0.08))] dark:border-white/10 bg-[var(--ui-bg-surface,#ffffff)] dark:bg-white/[0.02] shadow-sm justify-between gap-4',
        children: [
          jsxs('div', {
            className: 'flex flex-col gap-2',
            children: [
              jsxs('div', {
                className: 'flex items-center justify-between',
                children: [
                  jsxs('div', {
                    className: 'flex items-center gap-2',
                    children: [
                      jsx('span', { className: 'text-lg', children: '🌐' }),
                      jsx('span', { className: 'font-bold text-sm text-[var(--ui-text-primary,#0f172a)] dark:text-white', children: 'ForX New API 提供商' }),
                    ],
                  }),
                  jsx('span', {
                    className: 'px-2 py-0.5 rounded-full text-[10px] font-medium bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border border-emerald-500/20 flex items-center gap-1',
                    children: [
                      jsx('span', { className: 'w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse' }),
                      jsx('span', { children: '已接入 (Active)' }),
                    ],
                  }),
                ],
              }),
              jsx('p', {
                className: 'text-xs text-[var(--ui-text-secondary,#64748b)] dark:text-neutral-400 leading-relaxed',
                children: '聚合托管与本地免额度推理服务，自动记录千问 (Qwen)、智谱 (GLM) 等大模型的端到端上下文消耗与成本。',
              }),
            ],
          }),

          // Info Rows
          jsxs('div', {
            className: 'flex flex-col gap-2 p-3 rounded-lg bg-neutral-100/70 dark:bg-white/[0.03] text-xs font-mono',
            children: [
              jsxs('div', {
                className: 'flex items-center justify-between',
                children: [
                  jsx('span', { className: 'text-[var(--ui-text-tertiary,#64748b)]', children: '网关地址 Gateway' }),
                  jsx('span', {
                    className: 'font-medium text-[var(--ui-text-primary,#0f172a)] dark:text-white truncate max-w-[170px]',
                    title: newApi.portal_url || newApi.inference_url || 'http://192.168.0.191:3000',
                    children: (newApi.portal_url || newApi.inference_url || 'http://192.168.0.191:3000').replace(/^https?:\/\//, ''),
                  }),
                ],
              }),
              jsxs('div', {
                className: 'flex items-center justify-between',
                children: [
                  jsx('span', { className: 'text-[var(--ui-text-tertiary,#64748b)]', children: '认证模式 / 身份' }),
                  jsx('span', { className: 'font-medium text-[var(--ui-text-primary,#0f172a)] dark:text-white', children: newApi.username ? `已登录 (${newApi.username})` : '免密托管 (LatticeCode)' }),
                ],
              }),
              jsxs('div', {
                className: 'flex items-center justify-between',
                children: [
                  jsx('span', { className: 'text-[var(--ui-text-tertiary,#64748b)]', children: '覆盖活跃模型数' }),
                  jsx('span', { className: 'font-semibold text-indigo-600 dark:text-indigo-400', children: `${models.length} 个模型` }),
                ],
              }),
            ],
          }),

          // Bottom Tag
          jsx('div', {
            className: 'text-[11px] text-[var(--ui-text-tertiary,#94a3b8)] flex items-center gap-1',
            children: '💡 所有模型均通过 New API 网关统一路由，自动享受长上下文支持与 Prompt 缓存。',
          }),
        ],
      }),

      // Right 2 Cols: Models Ranking & Token Distribution
      jsxs('div', {
        className: 'lg:col-span-2 flex flex-col p-5 rounded-xl border border-[var(--ui-stroke-secondary,rgba(0,0,0,0.08))] dark:border-white/10 bg-[var(--ui-bg-surface,#ffffff)] dark:bg-white/[0.02] shadow-sm gap-3',
        children: [
          jsxs('div', {
            className: 'flex items-center justify-between',
            children: [
              jsxs('div', {
                className: 'flex items-center gap-2',
                children: [
                  jsx('span', { className: 'text-lg', children: '🤖' }),
                  jsx('span', { className: 'font-bold text-sm text-[var(--ui-text-primary,#0f172a)] dark:text-white', children: '模型使用情况与 Token 消耗排行' }),
                ],
              }),
              jsx('span', { className: 'text-xs text-[var(--ui-text-tertiary,#94a3b8)]', children: `已统计 ${models.length} 种模型` }),
            ],
          }),

          // Model items list
          jsx('div', {
            className: 'flex flex-col gap-2.5 overflow-y-auto max-h-[260px] pr-1',
            children: models.length === 0
              ? jsx('div', { className: 'text-xs text-center py-8 text-[var(--ui-text-tertiary,#94a3b8)]', children: '暂无模型调用数据' })
              : models.map((m) => {
                  const brand = getModelBrandBadge(m.model)
                  return jsxs(
                    'div',
                    {
                      className: 'flex flex-col gap-1.5 p-3 rounded-lg border border-[var(--ui-stroke-tertiary,rgba(0,0,0,0.05))] dark:border-white/5 bg-neutral-50/80 dark:bg-white/[0.015] hover:bg-neutral-100/80 dark:hover:bg-white/[0.03] transition-colors',
                      children: [
                        // Model Header
                        jsxs('div', {
                          className: 'flex items-center justify-between text-xs',
                          children: [
                            jsxs('div', {
                              className: 'flex items-center gap-2 truncate',
                              children: [
                                jsx('span', {
                                  className: 'px-1.5 py-0.5 rounded text-[10px] font-semibold shrink-0',
                                  style: { color: brand.color, backgroundColor: brand.bg },
                                  children: brand.label,
                                }),
                                jsx('span', {
                                  className: 'font-bold font-mono text-[var(--ui-text-primary,#0f172a)] dark:text-white truncate',
                                  children: m.model,
                                }),
                                jsx('span', {
                                  className: 'text-[10px] px-1.5 py-0.2 rounded bg-indigo-500/10 text-indigo-600 dark:text-indigo-300 font-medium shrink-0',
                                  children: 'ForX New API',
                                }),
                              ],
                            }),
                            jsxs('div', {
                              className: 'flex items-center gap-2 font-mono text-right shrink-0',
                              children: [
                                jsx('span', { className: 'font-bold text-[var(--ui-text-primary,#0f172a)] dark:text-white', children: fmtTokens(m.total_tokens) }),
                                jsx('span', { className: 'text-[11px] text-[var(--ui-text-secondary,#64748b)] dark:text-neutral-400 font-semibold', children: `${m.percentage}%` }),
                              ],
                            }),
                          ],
                        }),

                        // Progress Bar
                        jsx('div', {
                          className: 'w-full h-1.5 rounded-full bg-neutral-200 dark:bg-white/10 overflow-hidden',
                          children: jsx('div', {
                            className: 'h-full rounded-full transition-all duration-500',
                            style: {
                              width: `${Math.max(2, m.percentage)}%`,
                              backgroundColor: brand.color,
                            },
                          }),
                        }),

                        // Sub details
                        jsxs('div', {
                          className: 'flex items-center justify-between text-[11px] text-[var(--ui-text-tertiary,#64748b)] dark:text-neutral-400 font-mono mt-0.5',
                          children: [
                            jsxs('div', {
                              className: 'flex items-center gap-2',
                              children: [
                                jsx('span', { children: `${m.sessions} 次会话` }),
                                jsx('span', { children: '·' }),
                                jsx('span', { children: `入: ${fmtTokens(m.input_tokens)}` }),
                                jsx('span', { children: `出: ${fmtTokens(m.output_tokens)}` }),
                                m.cache_read_tokens > 0 && jsx('span', { className: 'text-emerald-600 dark:text-emerald-400', children: `Cache: ${fmtTokens(m.cache_read_tokens)}` }),
                              ],
                            }),
                            jsxs('div', {
                              className: 'flex items-center gap-1.5',
                              children: [
                                jsx('span', { children: `等价估值: ${fmtMoney(m.cost_usd)} (¥${m.cost_cny})` }),
                                m.is_free_tier && jsx('span', { className: 'text-[10px] text-emerald-600 dark:text-emerald-400 font-sans', children: '免额度' }),
                              ],
                            }),
                          ],
                        }),
                      ],
                    },
                    m.model
                  )
                }),
          }),
        ],
      }),
    ],
  })
}

// ─────────────────────────────────────────────────────────────
// COMPONENT: 7-Day / 30-Day Trend Bar Chart (SVG Native)
// ─────────────────────────────────────────────────────────────
function TrendChart({ data = [] }) {
  if (!data || data.length === 0) return null

  const maxTokens = Math.max(...data.map((d) => d.total_tokens || 0), 1000)
  const chartHeight = 120

  return jsxs('div', {
    className: 'flex flex-col p-4 rounded-xl border border-[var(--ui-stroke-secondary,rgba(0,0,0,0.08))] dark:border-white/10 bg-[var(--ui-bg-surface,#ffffff)] dark:bg-white/[0.02] shadow-sm',
    children: [
      jsxs('div', {
        className: 'flex items-center justify-between mb-3',
        children: [
          jsx('div', {
            className: 'text-sm font-semibold text-[var(--ui-text-primary,#0f172a)] dark:text-white',
            children: '📈 Token 消耗与 Cache 命中走势',
          }),
          jsxs('div', {
            className: 'flex items-center gap-3 text-xs text-[var(--ui-text-secondary,#64748b)] dark:text-[var(--ui-text-tertiary,#94a3b8)]',
            children: [
              jsxs('div', {
                className: 'flex items-center gap-1',
                children: [
                  jsx('span', { className: 'w-2 h-2 rounded bg-[#3b82f6]' }),
                  jsx('span', { children: 'Prompt Token' }),
                ],
              }),
              jsxs('div', {
                className: 'flex items-center gap-1',
                children: [
                  jsx('span', { className: 'w-2 h-2 rounded bg-[#10b981]' }),
                  jsx('span', { children: 'Cache 命中' }),
                ],
              }),
              jsxs('div', {
                className: 'flex items-center gap-1',
                children: [
                  jsx('span', { className: 'w-2 h-2 rounded bg-[#ec4899]' }),
                  jsx('span', { children: 'Output' }),
                ],
              }),
            ],
          }),
        ],
      }),
      jsx('div', {
        className: 'flex items-end justify-between gap-2 h-36 pt-4 pb-2 border-b border-neutral-200 dark:border-white/10',
        children: data.map((item) => {
          const total = item.total_tokens || 0
          const barHeight = Math.max(4, Math.round((total / maxTokens) * chartHeight))
          const inpHeight = Math.round(((item.input_tokens || 0) / Math.max(1, total)) * barHeight)
          const cacheHeight = Math.round(((item.cache_read_tokens || 0) / Math.max(1, total)) * barHeight)
          const outHeight = Math.max(0, barHeight - inpHeight - cacheHeight)

          return jsxs(
            'div',
            {
              className: 'flex-1 flex flex-col items-center gap-1 group relative',
              children: [
                // Hover tooltip
                jsxs('div', {
                  className: 'absolute -top-12 z-20 hidden group-hover:flex flex-col items-center px-2 py-1 bg-neutral-900 text-white border border-neutral-700 rounded shadow-lg text-[10px] whitespace-nowrap pointer-events-none',
                  children: [
                    jsx('span', { className: 'font-semibold text-white', children: item.date }),
                    jsx('span', {
                      className: 'text-neutral-300 font-mono',
                      children: `${fmtTokens(total)} tokens | ${fmtMoney(item.cost_usd)}`,
                    }),
                  ],
                }),
                // Stacked bar
                jsxs('div', {
                  className: 'w-full max-w-[36px] flex flex-col justify-end rounded-t overflow-hidden bg-neutral-100 dark:bg-white/5 transition-all group-hover:brightness-110',
                  style: { height: `${barHeight}px` },
                  children: [
                    jsx('div', { style: { height: `${outHeight}px`, backgroundColor: '#ec4899' } }),
                    jsx('div', { style: { height: `${cacheHeight}px`, backgroundColor: '#10b981' } }),
                    jsx('div', { style: { height: `${inpHeight}px`, backgroundColor: '#3b82f6' } }),
                  ],
                }),
                // Date label
                jsx('span', {
                  className: 'text-[10px] text-[var(--ui-text-tertiary,#64748b)] truncate',
                  children: item.date.slice(5),
                }),
              ],
            },
            item.date
          )
        }),
      }),
    ],
  })
}

// ─────────────────────────────────────────────────────────────
// COMPONENT: 8-Week Activity Heatmap (GitHub-style 56 days)
// ─────────────────────────────────────────────────────────────
function ActivityHeatmap({ data = [] }) {
  if (!data || data.length === 0) return null

  const levelColors = [
    'var(--heat-empty, rgba(128,128,128,0.12))', // 0: none
    'rgba(16, 185, 129, 0.35)', // 1: low
    'rgba(16, 185, 129, 0.60)', // 2: med
    'rgba(16, 185, 129, 0.85)', // 3: high
    '#10b981', // 4: max
  ]

  // Group into columns of 7 (each column is 1 week)
  const weeks = []
  for (let i = 0; i < data.length; i += 7) {
    weeks.push(data.slice(i, i + 7))
  }

  return jsxs('div', {
    className: 'flex flex-col p-4 rounded-xl border border-[var(--ui-stroke-secondary,rgba(0,0,0,0.08))] dark:border-white/10 bg-[var(--ui-bg-surface,#ffffff)] dark:bg-white/[0.02] shadow-sm',
    children: [
      jsxs('div', {
        className: 'flex items-center justify-between mb-3',
        children: [
          jsx('div', {
            className: 'text-sm font-semibold text-[var(--ui-text-primary,#0f172a)] dark:text-white',
            children: '📅 8 周活跃上下文热力图 (Activity Heatmap)',
          }),
          jsxs('div', {
            className: 'flex items-center gap-1.5 text-[10px] text-[var(--ui-text-tertiary,#94a3b8)]',
            children: [
              jsx('span', { children: '少 Less' }),
              levelColors.map((color, idx) =>
                jsx('span', {
                  className: 'w-2.5 h-2.5 rounded-xs inline-block',
                  style: { backgroundColor: color },
                }, idx)
              ),
              jsx('span', { children: '多 More' }),
            ],
          }),
        ],
      }),
      jsx('div', {
        className: 'flex items-center gap-1.5 overflow-x-auto py-2',
        children: weeks.map((week, wIdx) =>
          jsx(
            'div',
            {
              className: 'flex flex-col gap-1.5',
              children: week.map((day) =>
                jsx(
                  'div',
                  {
                    title: `${day.date}: ${day.sessions} 会话, ${fmtTokens(day.tokens)} tokens`,
                    className: 'w-3 h-3 rounded-xs transition-transform hover:scale-125 cursor-pointer',
                    style: { backgroundColor: levelColors[day.level || 0] },
                  },
                  day.date
                )
              ),
            },
            wIdx
          )
        ),
      }),
    ],
  })
}

// ─────────────────────────────────────────────────────────────
// COMPONENT: Sessions Table
// ─────────────────────────────────────────────────────────────
function SessionsTable({ sessions = [], onSelectSession }) {
  const [search, setSearch] = useState('')

  const filtered = useMemo(() => {
    if (!search.trim()) return sessions
    const q = search.toLowerCase()
    return sessions.filter(
      (s) =>
        (s.title && s.title.toLowerCase().includes(q)) ||
        (s.model && s.model.toLowerCase().includes(q)) ||
        (s.id && s.id.toLowerCase().includes(q))
    )
  }, [sessions, search])

  return jsxs('div', {
    className: 'flex flex-col p-4 rounded-xl border border-[var(--ui-stroke-secondary,rgba(0,0,0,0.08))] dark:border-white/10 bg-[var(--ui-bg-surface,#ffffff)] dark:bg-white/[0.02] shadow-sm',
    children: [
      jsxs('div', {
        className: 'flex items-center justify-between mb-3 gap-4',
        children: [
          jsx('div', {
            className: 'text-sm font-semibold text-[var(--ui-text-primary,#0f172a)] dark:text-white',
            children: `📋 活跃会话列表 (${filtered.length})`,
          }),
          jsx('div', {
            className: 'w-64',
            children: jsx(Input, {
              placeholder: '搜索会话标题、模型或 ID...',
              value: search,
              onChange: (e) => setSearch(e.target.value),
              className: 'h-8 text-xs',
            }),
          }),
        ],
      }),
      jsx('div', {
        className: 'overflow-x-auto',
        children: jsxs('table', {
          className: 'w-full text-left border-collapse text-xs',
          children: [
            jsx('thead', {
              children: jsxs('tr', {
                className: 'border-b border-neutral-200 dark:border-white/10 text-[var(--ui-text-secondary,#64748b)] dark:text-neutral-400 font-semibold',
                children: [
                  jsx('th', { className: 'py-2 px-3', children: '会话标题 / ID' }),
                  jsx('th', { className: 'py-2 px-3', children: '模型与提供商' }),
                  jsx('th', { className: 'py-2 px-3', children: '消息数' }),
                  jsx('th', { className: 'py-2 px-3', children: '上下文容量使用率' }),
                  jsx('th', { className: 'py-2 px-3', children: '预估费用' }),
                  jsx('th', { className: 'py-2 px-3 text-right', children: '操作' }),
                ],
              }),
            }),
            jsx('tbody', {
              children: filtered.map((s) => {
                const b = getStatusBadge(s.health_status)
                const brand = getModelBrandBadge(s.model)
                return jsxs(
                  'tr',
                  {
                    className: 'border-b border-neutral-100 dark:border-white/5 hover:bg-neutral-50 dark:hover:bg-white/[0.03] transition-colors',
                    children: [
                      jsxs('td', {
                        className: 'py-2.5 px-3 max-w-[220px]',
                        children: [
                          jsx('div', { className: 'font-medium text-[var(--ui-text-primary,#0f172a)] dark:text-white truncate', children: s.title }),
                          jsx('div', { className: 'text-[10px] text-[var(--ui-text-tertiary,#94a3b8)] font-mono truncate', children: s.id }),
                        ],
                      }),
                      jsxs('td', {
                        className: 'py-2.5 px-3 max-w-[170px]',
                        children: [
                          jsx('div', { className: 'font-mono text-[var(--ui-text-primary,#0f172a)] dark:text-neutral-200 truncate font-medium', children: s.model }),
                          jsxs('div', {
                            className: 'flex items-center gap-1 mt-0.5',
                            children: [
                              jsx('span', { className: 'text-[10px] px-1 rounded bg-indigo-500/10 text-indigo-600 dark:text-indigo-400 font-medium', children: 'New API' }),
                              jsx('span', { className: 'text-[10px] text-[var(--ui-text-tertiary,#94a3b8)]', children: brand.label }),
                            ],
                          }),
                        ],
                      }),
                      jsx('td', {
                        className: 'py-2.5 px-3 font-mono text-[var(--ui-text-primary,#0f172a)] dark:text-white',
                        children: s.message_count,
                      }),
                      jsxs('td', {
                        className: 'py-2.5 px-3 w-48',
                        children: [
                          jsxs('div', {
                            className: 'flex items-center justify-between text-[11px] mb-1 font-mono',
                            children: [
                              jsx('span', { style: { color: b.color }, children: `${s.usage_pct}%` }),
                              jsx('span', { className: 'text-[var(--ui-text-tertiary,#64748b)]', children: `${fmtTokens(s.active_tokens)}/${fmtTokens(s.context_limit)}` }),
                            ],
                          }),
                          jsx('div', {
                            className: 'w-full h-1.5 rounded-full bg-neutral-200 dark:bg-white/10 overflow-hidden',
                            children: jsx('div', {
                              className: 'h-full rounded-full',
                              style: {
                                width: `${Math.min(100, s.usage_pct)}%`,
                                backgroundColor: b.color,
                              },
                            }),
                          }),
                        ],
                      }),
                      jsxs('td', {
                        className: 'py-2.5 px-3 font-mono text-[var(--ui-text-primary,#0f172a)] dark:text-white',
                        children: [
                          jsx('span', { children: fmtMoney(s.cost_usd) }),
                          jsx('span', { className: 'text-[10px] text-emerald-600 dark:text-emerald-400 ml-1.5 font-sans', children: '免额度' }),
                        ],
                      }),
                      jsx('td', {
                        className: 'py-2.5 px-3 text-right',
                        children: jsx(Button, {
                          variant: 'ghost',
                          size: 'sm',
                          className: 'h-7 text-xs px-2.5',
                          onClick: () => onSelectSession(s.id),
                          children: '查看详情',
                        }),
                      }),
                    ],
                  },
                  s.id
                )
              }),
            }),
          ],
        }),
      }),
    ],
  })
}

// ─────────────────────────────────────────────────────────────
// COMPONENT: Full Dashboard Page (/context)
// ─────────────────────────────────────────────────────────────
function ContextDashboardPage({ ctx }) {
  const [selectedSessionId, setSelectedSessionId] = useState(null)
  const profile = useValue(host.state.profile)

  const { data, isLoading, isError, error, refetch } = useQuery({
    queryKey: ['forx-context', 'overview', profile],
    queryFn: () => ctx.rest(`/overview?profile=${encodeURIComponent(profile || '')}&days=14`),
    refetchInterval: 15000,
  })

  const { data: detailData, isLoading: detailLoading } = useQuery({
    queryKey: ['forx-context', 'session-detail', selectedSessionId, profile],
    queryFn: () => ctx.rest(`/sessions/${selectedSessionId}?profile=${encodeURIComponent(profile || '')}`),
    enabled: !!selectedSessionId,
  })

  if (isLoading && !data) {
    return jsxs('div', {
      className: 'flex h-full w-full items-center justify-center text-sm text-[var(--ui-text-tertiary,#94a3b8)] gap-2 bg-[var(--ui-bg-base)]',
      children: [
        jsx('div', { className: 'w-4 h-4 rounded-full border-2 border-indigo-500 border-t-transparent animate-spin' }),
        jsx('span', { children: '正在加载上下文全景数据...' }),
      ],
    })
  }

  const summary = data?.summary || {}

  return jsxs('div', {
    className: 'flex h-full w-full flex-col bg-[var(--ui-bg-base)] text-[var(--ui-text-primary,#0f172a)] dark:text-neutral-100 overflow-y-auto p-6 gap-6',
    children: [
      // Top Header
      jsxs('div', {
        className: 'flex items-center justify-between pb-4 border-b border-[var(--ui-stroke-secondary,rgba(0,0,0,0.08))] dark:border-white/10',
        children: [
          jsxs('div', {
            className: 'flex items-center gap-3',
            children: [
              jsx('div', {
                className: 'w-10 h-10 rounded-xl bg-gradient-to-br from-indigo-500 to-blue-600 flex items-center justify-center text-xl shadow-lg shadow-indigo-500/20 text-white',
                children: '⚡',
              }),
              jsxs('div', {
                children: [
                  jsx('h1', { className: 'text-xl font-bold tracking-tight text-[var(--ui-text-primary,#0f172a)] dark:text-white', children: 'Context 全景 (Context Insights)' }),
                  jsx('p', {
                    className: 'text-xs text-[var(--ui-text-secondary,#64748b)] dark:text-[var(--ui-text-tertiary,#94a3b8)]',
                    children: 'Agent 会话上下文深度洞察、Token与成本统计、多维度组成图谱及演化趋势可视化。',
                  }),
                ],
              }),
            ],
          }),
          jsxs('div', {
            className: 'flex items-center gap-2',
            children: [
              jsx(Button, {
                variant: 'outline',
                size: 'sm',
                onClick: () => {
                  haptic('tap')
                  refetch()
                },
                children: '刷新数据',
              }),
            ],
          }),
        ],
      }),

      // Error Banner if API call fails
      isError &&
        jsxs('div', {
          className: 'flex items-center justify-between p-4 rounded-xl border border-rose-500/30 bg-rose-500/10 text-rose-700 dark:text-rose-300 text-xs shadow-xs',
          children: [
            jsxs('div', {
              className: 'flex items-center gap-2.5',
              children: [
                jsx('span', { className: 'text-base', children: '⚠️' }),
                jsx('span', {
                  className: 'font-medium',
                  children: `无法获取上下文数据 (${error?.message || '插件后端未响应'})。请确认在设置中已启用 forx-context 插件并已启动网关服务。`,
                }),
              ],
            }),
            jsx(Button, {
              variant: 'outline',
              size: 'sm',
              onClick: () => {
                haptic('tap')
                refetch()
              },
              children: '重试连接',
            }),
          ],
        }),

      // KPI Cards Row
      jsxs('div', {
        className: 'grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4',
        children: [
          jsx(KpiCard, {
            title: '活跃会话数 (Active Sessions)',
            value: summary.total_sessions || 0,
            subtext: `安全 ${summary.status_counts?.safe || 0} / 临界 ${summary.status_counts?.critical || 0}`,
            icon: '💬',
          }),
          jsx(KpiCard, {
            title: '累计消耗 Token (Total Tokens)',
            value: fmtTokens(summary.total_tokens || 0),
            subtext: `输入 ${fmtTokens(summary.input_tokens || 0)} · 输出 ${fmtTokens(summary.output_tokens || 0)}`,
            icon: '⚡',
          }),
          jsx(KpiCard, {
            title: 'Cache 命中率 (Cache Hit Rate)',
            value: `${summary.cache_hit_rate || 0}%`,
            subtext: `命中 ${fmtTokens(summary.cache_read_tokens || 0)} prompt tokens`,
            icon: '🎯',
          }),
          jsx(KpiCard, {
            title: '算力等价估值 (Estimated Cost)',
            value: fmtMoney(summary.total_cost_usd || 0),
            subtext: `约 ¥${summary.total_cost_cny || 0} CNY`,
            icon: '💰',
            tag: 'New API 托管',
          }),
        ],
      }),

      // Model & Provider Breakdown Section
      jsx(ModelDistributionSection, {
        models: data?.models || [],
        newApi: data?.new_api || {},
        providers: data?.providers || [],
      }),

      // Charts Row (Trend + Heatmap)
      jsxs('div', {
        className: 'grid grid-cols-1 lg:grid-cols-2 gap-4',
        children: [
          jsx(TrendChart, { data: data?.trend || [] }),
          jsx(ActivityHeatmap, { data: data?.heatmap || [] }),
        ],
      }),

      // Sessions Table
      jsx(SessionsTable, {
        sessions: data?.sessions || [],
        onSelectSession: (sid) => setSelectedSessionId(sid),
      }),

      // Selected Session Detail Modal
      selectedSessionId &&
        jsxs('div', {
          className: 'fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-xs p-4',
          onClick: () => setSelectedSessionId(null),
          children: [
            jsxs('div', {
              className: 'flex flex-col w-full max-w-4xl max-h-[90vh] rounded-2xl border border-[var(--ui-stroke-secondary,rgba(0,0,0,0.1))] dark:border-white/10 bg-[var(--ui-bg-elevated,#ffffff)] dark:bg-[#0f172a] text-[var(--ui-text-primary,#0f172a)] dark:text-white shadow-2xl overflow-hidden',
              onClick: (e) => e.stopPropagation(),
              children: [
                // Modal Header
                jsxs('div', {
                  className: 'flex items-center justify-between p-4 border-b border-neutral-200 dark:border-white/10 bg-neutral-50 dark:bg-white/[0.02]',
                  children: [
                    jsxs('div', {
                      className: 'flex items-center gap-2 truncate pr-4',
                      children: [
                        jsx('span', { className: 'text-lg', children: '🔍' }),
                        jsx('span', { className: 'text-base font-bold text-[var(--ui-text-primary,#0f172a)] dark:text-white truncate', children: detailData?.session?.title || '会话详情' }),
                        jsx('span', { className: 'text-xs font-mono px-2 py-0.5 rounded bg-indigo-500/10 text-indigo-600 dark:text-indigo-400', children: detailData?.session?.model || 'model' }),
                      ],
                    }),
                    jsx(Button, {
                      variant: 'ghost',
                      size: 'sm',
                      onClick: () => setSelectedSessionId(null),
                      children: '✕ 关闭',
                    }),
                  ],
                }),

                // Modal Body
                detailLoading && !detailData
                  ? jsx('div', { className: 'p-12 text-center text-xs text-[var(--ui-text-tertiary,#94a3b8)]', children: '正在深入解析单会话上下文构成...' })
                  : jsxs('div', {
                      className: 'flex flex-col gap-5 p-6 overflow-y-auto',
                      children: [
                        // Gauge & Top Stats
                        jsxs('div', {
                          className: 'grid grid-cols-1 md:grid-cols-3 gap-4',
                          children: [
                            jsx(ContextGauge, {
                              pct: detailData?.capacity?.usage_pct || 0,
                              activeTokens: detailData?.capacity?.active_tokens || 0,
                              limit: detailData?.capacity?.context_limit || 128000,
                              status: detailData?.capacity?.health_status || 'safe',
                              compactedTokens: detailData?.capacity?.compacted_tokens || 0,
                            }),
                            jsxs('div', {
                              className: 'md:col-span-2 flex flex-col justify-between gap-3 p-4 rounded-xl border border-[var(--ui-stroke-secondary,rgba(0,0,0,0.08))] dark:border-white/10 bg-neutral-50/50 dark:bg-white/[0.02]',
                              children: [
                                jsxs('div', {
                                  className: 'grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs',
                                  children: [
                                    jsxs('div', {
                                      className: 'flex flex-col',
                                      children: [
                                        jsx('span', { className: 'text-[11px] text-[var(--ui-text-tertiary,#94a3b8)]', children: '消息总数' }),
                                        jsx('span', { className: 'font-mono text-base font-bold text-[var(--ui-text-primary,#0f172a)] dark:text-white', children: detailData?.session?.message_count || 0 }),
                                      ],
                                    }),
                                    jsxs('div', {
                                      className: 'flex flex-col',
                                      children: [
                                        jsx('span', { className: 'text-[11px] text-[var(--ui-text-tertiary,#94a3b8)]', children: '输入 Tokens' }),
                                        jsx('span', { className: 'font-mono text-base font-bold text-[var(--ui-text-primary,#0f172a)] dark:text-white', children: fmtTokens(detailData?.tokens?.input_tokens || 0) }),
                                      ],
                                    }),
                                    jsxs('div', {
                                      className: 'flex flex-col',
                                      children: [
                                        jsx('span', { className: 'text-[11px] text-[var(--ui-text-tertiary,#94a3b8)]', children: '输出 Tokens' }),
                                        jsx('span', { className: 'font-mono text-base font-bold text-[var(--ui-text-primary,#0f172a)] dark:text-white', children: fmtTokens(detailData?.tokens?.output_tokens || 0) }),
                                      ],
                                    }),
                                    jsxs('div', {
                                      className: 'flex flex-col',
                                      children: [
                                        jsx('span', { className: 'text-[11px] text-[var(--ui-text-tertiary,#94a3b8)]', children: '预估等价成本' }),
                                        jsx('span', { className: 'font-mono text-base font-bold text-emerald-600 dark:text-emerald-400', children: fmtMoney(detailData?.cost?.cost_usd || 0) }),
                                      ],
                                    }),
                                  ],
                                }),
                                jsx(BreakdownBar, {
                                  segments: detailData?.breakdown?.segments || [],
                                  activeTokens: detailData?.capacity?.active_tokens || 1,
                                }),
                              ],
                            }),
                          ],
                        }),

                        // Tools & Timeline
                        jsxs('div', {
                          className: 'grid grid-cols-1 md:grid-cols-2 gap-4',
                          children: [
                            // Tools
                            jsxs('div', {
                              className: 'flex flex-col p-4 rounded-xl border border-[var(--ui-stroke-secondary,rgba(0,0,0,0.08))] dark:border-white/10 bg-neutral-50/50 dark:bg-white/[0.02]',
                              children: [
                                jsx('div', { className: 'text-xs font-semibold text-[var(--ui-text-primary,#0f172a)] dark:text-white mb-2', children: '🛠️ 工具调用频次 (Tool Executions)' }),
                                (detailData?.tools || []).length === 0
                                  ? jsx('div', { className: 'text-xs text-[var(--ui-text-tertiary,#94a3b8)] py-4 text-center', children: '本会话无工具调用' })
                                  : jsx('div', {
                                      className: 'flex flex-col gap-1.5 max-h-48 overflow-y-auto',
                                      children: detailData.tools.map((t) =>
                                        jsxs(
                                          'div',
                                          {
                                            className: 'flex items-center justify-between text-xs py-1 px-2 rounded bg-neutral-100 dark:bg-white/[0.02]',
                                            children: [
                                              jsx('span', { className: 'font-mono text-indigo-600 dark:text-cyan-400', children: t.name }),
                                              jsxs('div', {
                                                className: 'flex items-center gap-3 font-mono text-[11px] text-[var(--ui-text-tertiary,#64748b)]',
                                                children: [
                                                  jsx('span', { children: `${t.calls} 次` }),
                                                  t.errors > 0 && jsx('span', { className: 'text-red-500', children: `${t.errors} 错误` }),
                                                  jsx('span', { children: `${fmtTokens(t.tokens)} tok` }),
                                                ],
                                              }),
                                            ],
                                          },
                                          t.name
                                        )
                                      ),
                                    }),
                              ],
                            }),

                            // Evolution Timeline
                            jsxs('div', {
                              className: 'flex flex-col p-4 rounded-xl border border-[var(--ui-stroke-secondary,rgba(0,0,0,0.08))] dark:border-white/10 bg-neutral-50/50 dark:bg-white/[0.02]',
                              children: [
                                jsx('div', { className: 'text-xs font-semibold text-[var(--ui-text-primary,#0f172a)] dark:text-white mb-2', children: '⏱️ 演进时间线 (Timeline Steps)' }),
                                (detailData?.timeline || []).length === 0
                                  ? jsx('div', { className: 'text-xs text-[var(--ui-text-tertiary,#94a3b8)] py-4 text-center', children: '暂无时间线记录' })
                                  : jsx('div', {
                                      className: 'flex flex-col gap-1.5 max-h-48 overflow-y-auto font-mono',
                                      children: detailData.timeline.slice(-15).map((step) =>
                                        jsxs(
                                          'div',
                                          {
                                            className: 'flex items-center justify-between text-[11px] py-1 px-2 rounded bg-neutral-100 dark:bg-white/[0.02]',
                                            children: [
                                              jsxs('div', {
                                                className: 'flex items-center gap-1.5 truncate pr-2',
                                                children: [
                                                  jsx('span', { className: 'text-[var(--ui-text-tertiary,#94a3b8)] font-bold', children: `#${step.step}` }),
                                                  jsx('span', { className: 'text-indigo-600 dark:text-indigo-400 capitalize', children: step.role }),
                                                  jsx('span', { className: 'text-[var(--ui-text-secondary,#475569)] dark:text-neutral-300 truncate max-w-[180px]', children: step.preview }),
                                                ],
                                              }),
                                              jsx('span', { className: 'text-[var(--ui-text-tertiary,#94a3b8)] shrink-0', children: `${fmtTokens(step.tokens)} tok` }),
                                            ],
                                          },
                                          step.step
                                        )
                                      ),
                                    }),
                              ],
                            }),
                          ],
                        }),
                      ],
                    }),
              ],
            }),
          ],
        }),
    ],
  })
}

// ─────────────────────────────────────────────────────────────
// COMPONENT: Right Drawer Pane (Companion Inspector Pane)
// ─────────────────────────────────────────────────────────────
function ContextPane({ ctx }) {
  const focusedId = useValue(host.state.focusedStoredSessionId)
  const activeId = useValue(host.state.activeSessionId)
  const targetId = focusedId || activeId
  const profile = useValue(host.state.profile)

  const { data, isLoading, refetch } = useQuery({
    queryKey: ['forx-context', 'pane-session', targetId, profile],
    queryFn: () => {
      if (targetId) {
        return ctx.rest(`/sessions/${targetId}?profile=${encodeURIComponent(profile || '')}`)
      }
      return ctx.rest(`/current?profile=${encodeURIComponent(profile || '')}`)
    },
    refetchInterval: 8000,
  })

  return jsxs('div', {
    className: 'flex flex-col h-full w-full bg-[var(--ui-bg-base)] text-[var(--ui-text-primary,#0f172a)] dark:text-neutral-100 overflow-y-auto p-4 gap-4',
    children: [
      // Pane Header
      jsxs('div', {
        className: 'flex items-center justify-between pb-2 border-b border-[var(--ui-stroke-secondary,rgba(0,0,0,0.08))] dark:border-white/10',
        children: [
          jsxs('div', {
            className: 'flex items-center gap-2',
            children: [
              jsx('span', { className: 'text-base', children: '⚡' }),
              jsx('span', { className: 'font-semibold text-xs tracking-wide text-[var(--ui-text-primary,#0f172a)] dark:text-white', children: 'Context 全景透视' }),
            ],
          }),
          jsx(Button, {
            variant: 'ghost',
            size: 'sm',
            className: 'h-6 text-[11px] px-1.5',
            onClick: () => {
              haptic('tap')
              refetch()
            },
            children: '刷新',
          }),
        ],
      }),

      isLoading && !data
        ? jsx('div', { className: 'p-8 text-center text-xs text-[var(--ui-text-tertiary,#94a3b8)]', children: '分析上下文容量中...' })
        : jsxs(React.Fragment, {
            children: [
              // Session title chip
              jsxs('div', {
                className: 'px-2.5 py-1.5 rounded-lg border border-[var(--ui-stroke-secondary,rgba(0,0,0,0.08))] dark:border-white/5 bg-[var(--ui-bg-surface,#ffffff)] dark:bg-white/[0.02] flex flex-col gap-0.5',
                children: [
                  jsx('div', { className: 'text-[11px] font-medium text-[var(--ui-text-primary,#0f172a)] dark:text-white truncate', children: data?.session?.title || '未命名会话' }),
                  jsxs('div', {
                    className: 'text-[10px] text-[var(--ui-text-tertiary,#64748b)] font-mono flex items-center justify-between',
                    children: [
                      jsx('span', { children: `${data?.session?.model || 'model'} · New API` }),
                      jsx('span', { children: `${data?.session?.message_count || 0} 消息` }),
                    ],
                  }),
                ],
              }),

              // Gauge
              jsx(ContextGauge, {
                pct: data?.capacity?.usage_pct || 0,
                activeTokens: data?.capacity?.active_tokens || 0,
                limit: data?.capacity?.context_limit || 128000,
                status: data?.capacity?.health_status || 'safe',
                compactedTokens: data?.capacity?.compacted_tokens || 0,
              }),

              // Tokens & Spend Quick Stats
              jsxs('div', {
                className: 'grid grid-cols-2 gap-2 text-xs',
                children: [
                  jsxs('div', {
                    className: 'p-2.5 rounded-lg border border-[var(--ui-stroke-secondary,rgba(0,0,0,0.08))] dark:border-white/5 bg-[var(--ui-bg-surface,#ffffff)] dark:bg-white/[0.02] flex flex-col',
                    children: [
                      jsx('span', { className: 'text-[10px] text-[var(--ui-text-tertiary,#94a3b8)]', children: 'Prompt 累计' }),
                      jsx('span', { className: 'font-bold font-mono text-[var(--ui-text-primary,#0f172a)] dark:text-white mt-0.5', children: fmtTokens(data?.tokens?.input_tokens || 0) }),
                    ],
                  }),
                  jsxs('div', {
                    className: 'p-2.5 rounded-lg border border-[var(--ui-stroke-secondary,rgba(0,0,0,0.08))] dark:border-white/5 bg-[var(--ui-bg-surface,#ffffff)] dark:bg-white/[0.02] flex flex-col',
                    children: [
                      jsx('span', { className: 'text-[10px] text-[var(--ui-text-tertiary,#94a3b8)]', children: 'Cache 命中' }),
                      jsx('span', { className: 'font-bold font-mono text-[#10b981] mt-0.5', children: `${data?.tokens?.cache_hit_rate || 0}%` }),
                    ],
                  }),
                ],
              }),

              // Breakdown
              jsx(BreakdownBar, {
                segments: data?.breakdown?.segments || [],
                activeTokens: data?.capacity?.active_tokens || 1,
              }),

              // Tools
              (data?.tools || []).length > 0 &&
                jsxs('div', {
                  className: 'flex flex-col gap-1.5 p-3 rounded-lg border border-[var(--ui-stroke-secondary,rgba(0,0,0,0.08))] dark:border-white/5 bg-[var(--ui-bg-surface,#ffffff)] dark:bg-white/[0.02]',
                  children: [
                    jsx('div', { className: 'text-xs font-semibold text-[var(--ui-text-primary,#0f172a)] dark:text-[var(--ui-text-secondary,#cbd5e1)]', children: '🛠️ 工具调用' }),
                    jsx('div', {
                      className: 'flex flex-wrap gap-1.5 mt-1',
                      children: data.tools.slice(0, 6).map((t) =>
                        jsxs(
                          'span',
                          {
                            className: 'px-2 py-0.5 rounded text-[10px] font-mono bg-neutral-100 dark:bg-white/5 border border-neutral-200 dark:border-white/10 flex items-center gap-1',
                            children: [
                              jsx('span', { className: 'text-indigo-600 dark:text-cyan-400 font-medium', children: t.name }),
                              jsx('span', { className: 'text-[var(--ui-text-tertiary,#94a3b8)]', children: `x${t.calls}` }),
                            ],
                          },
                          t.name
                        )
                      ),
                    }),
                  ],
                }),

              // Open Full Dashboard Button
              jsx(Button, {
                variant: 'outline',
                className: 'w-full text-xs h-8 mt-2',
                onClick: () => {
                  haptic('tap')
                  host.navigate('/context')
                },
                children: '打开全景大屏总览 →',
              }),
            ],
          }),
    ],
  })
}

// ─────────────────────────────────────────────────────────────
// COMPONENT: Statusbar Chip
// ─────────────────────────────────────────────────────────────
function ContextStatusbarChip({ ctx }) {
  const focusedId = useValue(host.state.focusedStoredSessionId)
  const activeId = useValue(host.state.activeSessionId)
  const targetId = focusedId || activeId
  const profile = useValue(host.state.profile)

  const { data } = useQuery({
    queryKey: ['forx-context', 'chip', targetId, profile],
    queryFn: () => {
      if (targetId) {
        return ctx.rest(`/sessions/${targetId}?profile=${encodeURIComponent(profile || '')}`)
      }
      return ctx.rest(`/current?profile=${encodeURIComponent(profile || '')}`)
    },
    refetchInterval: 12000,
  })

  if (!data?.capacity) return null

  const pct = data.capacity.usage_pct || 0
  const b = getStatusBadge(data.capacity.health_status)

  return jsxs('button', {
    type: 'button',
    className: 'flex items-center gap-1.5 px-2 py-0.5 text-[11px] font-mono rounded hover:bg-neutral-200/50 dark:hover:bg-white/10 transition-colors',
    onClick: () => {
      haptic('tap')
      host.navigate('/context')
    },
    title: `Context 容量: ${fmtTokens(data.capacity.active_tokens)} / ${fmtTokens(data.capacity.context_limit)} (${pct}%) - 点击查看全景`,
    children: [
      jsx('span', {
        className: 'w-1.5 h-1.5 rounded-full animate-pulse',
        style: { backgroundColor: b.color },
      }),
      jsx('span', { className: 'text-[var(--ui-text-secondary,#64748b)] dark:text-[var(--ui-text-secondary,#cbd5e1)]', children: '⚡' }),
      jsx('span', { className: 'font-medium', style: { color: b.color }, children: `${pct}%` }),
    ],
  })
}

// ─────────────────────────────────────────────────────────────
// HermesPlugin Contract Export
// ─────────────────────────────────────────────────────────────
export default {
  id: PLUGIN_ID,
  name: 'Context 全景 (Context Insights)',
  defaultEnabled: true,
  register(ctx) {
    // 1. Right Layout Pane: Context Companion
    ctx.register({
      id: 'pane',
      area: PANES_AREA,
      title: 'Context 全景',
      data: { placement: 'right', width: '340px' },
      render: () => jsx(ContextPane, { ctx }),
    })

    // 2. Full Page Route: /context
    ctx.register({
      id: 'route',
      area: ROUTES_AREA,
      data: { path: '/context' },
      render: () => jsx(ContextDashboardPage, { ctx }),
    })

    // 3. Sidebar Nav Row
    ctx.register({
      id: 'nav',
      area: SIDEBAR_NAV_AREA,
      data: { path: '/context', label: 'Context 全景', codicon: 'dashboard' },
    })

    // 4. Status Bar Indicator
    ctx.register({
      id: 'statusbar',
      area: STATUSBAR_AREAS.right,
      order: 110,
      render: () => jsx(ContextStatusbarChip, { ctx }),
    })

    // 5. Palette ⌘K Commands
    ctx.registerMany([
      {
        id: 'palette-open',
        area: PALETTE_AREA,
        data: {
          id: 'context.open',
          label: 'Open Context Dashboard (打开 Context 全景大屏)',
          keywords: ['context', 'tokens', 'capacity', 'dashboard', '全景', '上下文'],
          run: () => host.navigate('/context'),
        },
      },
    ])
  },
}
