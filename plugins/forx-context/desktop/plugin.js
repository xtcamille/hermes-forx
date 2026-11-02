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

// ─────────────────────────────────────────────────────────────
// COMPONENT: Context Gauge (Circular Capacity)
// ─────────────────────────────────────────────────────────────
function ContextGauge({ pct = 0, activeTokens = 0, limit = 128000, status = 'safe', compactedTokens = 0 }) {
  const badge = getStatusBadge(status)
  const radius = 42
  const circ = 2 * Math.PI * radius
  const cappedPct = Math.min(100, Math.max(0, pct))
  const strokeDash = (cappedPct / 100) * circ

  return jsxs('div', {
    className: 'flex flex-col items-center justify-center p-4 rounded-xl border border-[var(--ui-border,rgba(255,255,255,0.08))] bg-[var(--ui-bg-card,rgba(255,255,255,0.02))] relative',
    children: [
      jsxs('div', {
        className: 'relative flex items-center justify-center w-28 h-28',
        children: [
          jsxs('svg', {
            className: 'w-28 h-28 transform -rotate-90',
            viewBox: '0 0 100 100',
            children: [
              jsx('circle', {
                cx: '50',
                cy: '50',
                r: radius,
                stroke: 'rgba(255,255,255,0.08)',
                strokeWidth: '8',
                fill: 'transparent',
              }),
              jsx('circle', {
                cx: '50',
                cy: '50',
                r: radius,
                stroke: badge.color,
                strokeWidth: '8',
                strokeDasharray: circ,
                strokeDashoffset: circ - strokeDash,
                strokeLinecap: 'round',
                fill: 'transparent',
                style: { transition: 'stroke-dashoffset 0.6s ease' },
              }),
            ],
          }),
          jsxs('div', {
            className: 'absolute flex flex-col items-center justify-center text-center',
            children: [
              jsx('span', {
                className: 'text-xl font-bold tracking-tight',
                style: { color: badge.color },
                children: `${cappedPct}%`,
              }),
              jsx('span', {
                className: 'text-[10px] text-[var(--ui-text-tertiary,#94a3b8)]',
                children: '已用容量',
              }),
            ],
          }),
        ],
      }),
      jsxs('div', {
        className: 'mt-3 flex flex-col items-center gap-1 text-center',
        children: [
          jsx('span', {
            className: 'px-2 py-0.5 text-[11px] font-medium rounded-full border',
            style: { color: badge.color, borderColor: badge.color, backgroundColor: badge.bg },
            children: badge.label,
          }),
          jsxs('div', {
            className: 'text-xs text-[var(--ui-text-secondary,#cbd5e1)] mt-1 font-mono',
            children: [
              fmtTokens(activeTokens),
              jsx('span', { className: 'text-[var(--ui-text-tertiary,#64748b)] mx-1', children: '/' }),
              fmtTokens(limit),
              jsx('span', { className: 'text-[10px] text-[var(--ui-text-tertiary,#64748b)] ml-1', children: 'tokens' }),
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
    className: 'flex flex-col gap-2.5 p-3 rounded-lg border border-[var(--ui-border,rgba(255,255,255,0.08))] bg-[var(--ui-bg-card,rgba(255,255,255,0.02))]',
    children: [
      jsx('div', {
        className: 'text-xs font-semibold text-[var(--ui-text-secondary,#cbd5e1)] mb-1',
        children: '🧩 上下文组成分布 (Breakdown)',
      }),
      jsx('div', {
        className: 'w-full h-3.5 flex rounded-md overflow-hidden bg-black/20 p-0.5 gap-0.5',
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
                      className: 'text-[var(--ui-text-secondary,#cbd5e1)] truncate',
                      children: seg.label,
                    }),
                  ],
                }),
                jsxs('div', {
                  className: 'font-mono text-right shrink-0',
                  children: [
                    jsx('span', { className: 'font-medium text-white', children: fmtTokens(seg.tokens) }),
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
function KpiCard({ title, value, subtext, icon, trend }) {
  return jsxs('div', {
    className: 'flex flex-col p-4 rounded-xl border border-[var(--ui-border,rgba(255,255,255,0.08))] bg-[var(--ui-bg-card,rgba(255,255,255,0.02))] relative overflow-hidden',
    children: [
      jsxs('div', {
        className: 'flex items-center justify-between text-xs text-[var(--ui-text-tertiary,#94a3b8)] mb-2',
        children: [
          jsx('span', { children: title }),
          icon && jsx('span', { className: 'text-sm opacity-80', children: icon }),
        ],
      }),
      jsx('div', {
        className: 'text-2xl font-bold tracking-tight text-white mb-1 font-mono',
        children: value,
      }),
      subtext &&
        jsx('div', {
          className: 'text-[11px] text-[var(--ui-text-tertiary,#94a3b8)] flex items-center gap-1',
          children: subtext,
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
    className: 'flex flex-col p-4 rounded-xl border border-[var(--ui-border,rgba(255,255,255,0.08))] bg-[var(--ui-bg-card,rgba(255,255,255,0.02))]',
    children: [
      jsxs('div', {
        className: 'flex items-center justify-between mb-3',
        children: [
          jsx('div', {
            className: 'text-sm font-semibold text-white',
            children: '📈 Token 消耗与 Cache 命中走势',
          }),
          jsxs('div', {
            className: 'flex items-center gap-3 text-xs text-[var(--ui-text-tertiary,#94a3b8)]',
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
        className: 'flex items-end justify-between gap-2 h-36 pt-4 pb-2 border-b border-white/5',
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
                  className: 'absolute -top-12 z-20 hidden group-hover:flex flex-col items-center px-2 py-1 bg-neutral-900 border border-white/10 rounded shadow-lg text-[10px] whitespace-nowrap pointer-events-none',
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
                  className: 'w-full max-w-[36px] flex flex-col justify-end rounded-t overflow-hidden bg-white/5 transition-all group-hover:brightness-125',
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
    'rgba(255,255,255,0.04)', // 0: none
    'rgba(16, 185, 129, 0.3)', // 1: low
    'rgba(16, 185, 129, 0.55)', // 2: med
    'rgba(16, 185, 129, 0.8)', // 3: high
    '#10b981', // 4: max
  ]

  // Group into columns of 7 (each column is 1 week)
  const weeks = []
  for (let i = 0; i < data.length; i += 7) {
    weeks.push(data.slice(i, i + 7))
  }

  return jsxs('div', {
    className: 'flex flex-col p-4 rounded-xl border border-[var(--ui-border,rgba(255,255,255,0.08))] bg-[var(--ui-bg-card,rgba(255,255,255,0.02))]',
    children: [
      jsxs('div', {
        className: 'flex items-center justify-between mb-3',
        children: [
          jsx('div', {
            className: 'text-sm font-semibold text-white',
            children: '📅 8 周活跃上下文热力图 (Activity Heatmap)',
          }),
          jsxs('div', {
            className: 'flex items-center gap-1.5 text-[10px] text-[var(--ui-text-tertiary,#94a3b8)]',
            children: [
              jsx('span', { children: '少 Less' }),
              levelColors.map((color, idx) =>
                jsx('span', {
                  className: 'w-2.5 h-2.5 rounded-sm',
                  style: { backgroundColor: color },
                }, idx)
              ),
              jsx('span', { children: '多 More' }),
            ],
          }),
        ],
      }),
      jsx('div', {
        className: 'flex items-center gap-1.5 overflow-x-auto pb-1',
        children: weeks.map((week, wIdx) =>
          jsx(
            'div',
            {
              className: 'flex flex-col gap-1.5',
              children: week.map((day) =>
                jsx(
                  'div',
                  {
                    title: `${day.date}: ${fmtTokens(day.tokens)} tokens (${day.sessions} 会话)`,
                    className: 'w-3 h-3 rounded-sm transition-transform hover:scale-125 cursor-pointer',
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
      (s) => s.title.toLowerCase().includes(q) || s.id.toLowerCase().includes(q) || s.model.toLowerCase().includes(q)
    )
  }, [sessions, search])

  return jsxs('div', {
    className: 'flex flex-col p-4 rounded-xl border border-[var(--ui-border,rgba(255,255,255,0.08))] bg-[var(--ui-bg-card,rgba(255,255,255,0.02))]',
    children: [
      jsxs('div', {
        className: 'flex items-center justify-between mb-3 gap-4',
        children: [
          jsx('div', {
            className: 'text-sm font-semibold text-white',
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
                className: 'border-b border-white/10 text-[var(--ui-text-tertiary,#94a3b8)]',
                children: [
                  jsx('th', { className: 'py-2 px-3 font-medium', children: '会话标题 / ID' }),
                  jsx('th', { className: 'py-2 px-3 font-medium', children: '模型' }),
                  jsx('th', { className: 'py-2 px-3 font-medium', children: '消息数' }),
                  jsx('th', { className: 'py-2 px-3 font-medium', children: '上下文容量使用率' }),
                  jsx('th', { className: 'py-2 px-3 font-medium', children: '预估费用' }),
                  jsx('th', { className: 'py-2 px-3 font-medium text-right', children: '操作' }),
                ],
              }),
            }),
            jsx('tbody', {
              children: filtered.map((s) => {
                const b = getStatusBadge(s.health_status)
                return jsxs(
                  'tr',
                  {
                    className: 'border-b border-white/5 hover:bg-white/[0.03] transition-colors',
                    children: [
                      jsxs('td', {
                        className: 'py-2.5 px-3 max-w-[220px]',
                        children: [
                          jsx('div', { className: 'font-medium text-white truncate', children: s.title }),
                          jsx('div', { className: 'text-[10px] text-[var(--ui-text-tertiary,#64748b)] font-mono truncate', children: s.id }),
                        ],
                      }),
                      jsx('td', {
                        className: 'py-2.5 px-3 font-mono text-[var(--ui-text-secondary,#cbd5e1)] truncate max-w-[140px]',
                        children: s.model,
                      }),
                      jsx('td', {
                        className: 'py-2.5 px-3 font-mono text-white',
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
                            className: 'w-full h-1.5 rounded-full bg-white/10 overflow-hidden',
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
                      jsx('td', {
                        className: 'py-2.5 px-3 font-mono text-white',
                        children: fmtMoney(s.cost_usd),
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

  const { data, isLoading, refetch } = useQuery({
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
      className: 'flex h-full w-full items-center justify-center text-sm text-[var(--ui-text-tertiary,#94a3b8)] gap-2',
      children: [
        jsx('div', { className: 'w-4 h-4 rounded-full border-2 border-white/20 border-t-white animate-spin' }),
        jsx('span', { children: '正在加载上下文全景数据...' }),
      ],
    })
  }

  const summary = data?.summary || {}

  return jsxs('div', {
    className: 'flex h-full w-full flex-col bg-[var(--ui-bg-base,#0b0f17)] text-white overflow-y-auto p-6 gap-6',
    children: [
      // Top Header
      jsxs('div', {
        className: 'flex items-center justify-between pb-4 border-b border-white/10',
        children: [
          jsxs('div', {
            className: 'flex items-center gap-3',
            children: [
              jsx('div', {
                className: 'w-10 h-10 rounded-xl bg-gradient-to-br from-cyan-500 to-blue-600 flex items-center justify-center text-xl shadow-lg shadow-cyan-500/20',
                children: '⚡',
              }),
              jsxs('div', {
                children: [
                  jsx('h1', { className: 'text-xl font-bold tracking-tight', children: 'Context 全景 (Context Insights)' }),
                  jsx('p', {
                    className: 'text-xs text-[var(--ui-text-tertiary,#94a3b8)]',
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
            title: '累计预估花费 (Estimated Cost)',
            value: fmtMoney(summary.total_cost_usd || 0),
            subtext: `约 ¥${summary.total_cost_cny || 0} CNY`,
            icon: '💰',
          }),
        ],
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
          className: 'fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4',
          onClick: () => setSelectedSessionId(null),
          children: [
            jsxs('div', {
              className: 'flex flex-col w-full max-w-4xl max-h-[90vh] rounded-2xl border border-white/10 bg-[#0f172a] shadow-2xl overflow-hidden',
              onClick: (e) => e.stopPropagation(),
              children: [
                // Modal Header
                jsxs('div', {
                  className: 'flex items-center justify-between p-4 border-b border-white/10 bg-white/[0.02]',
                  children: [
                    jsxs('div', {
                      className: 'flex items-center gap-2 truncate pr-4',
                      children: [
                        jsx('span', { className: 'text-base font-bold text-white truncate', children: detailData?.session?.title || '会话详情' }),
                        jsx('span', { className: 'text-xs text-[var(--ui-text-tertiary,#94a3b8)] font-mono', children: selectedSessionId }),
                      ],
                    }),
                    jsx(Button, {
                      variant: 'ghost',
                      size: 'sm',
                      onClick: () => setSelectedSessionId(null),
                      children: '✕',
                    }),
                  ],
                }),
                // Modal Body
                detailLoading
                  ? jsx('div', { className: 'p-12 text-center text-sm text-[var(--ui-text-tertiary,#94a3b8)]', children: '加载会话详情中...' })
                  : jsxs('div', {
                      className: 'flex-1 overflow-y-auto p-6 flex flex-col gap-5',
                      children: [
                        // Row 1: Gauge + Breakdown Bar
                        jsxs('div', {
                          className: 'grid grid-cols-1 md:grid-cols-3 gap-4',
                          children: [
                            jsx('div', {
                              className: 'md:col-span-1',
                              children: jsx(ContextGauge, {
                                pct: detailData?.capacity?.usage_pct || 0,
                                activeTokens: detailData?.capacity?.active_tokens || 0,
                                limit: detailData?.capacity?.context_limit || 128000,
                                status: detailData?.capacity?.health_status || 'safe',
                                compactedTokens: detailData?.capacity?.compacted_tokens || 0,
                              }),
                            }),
                            jsx('div', {
                              className: 'md:col-span-2',
                              children: jsx(BreakdownBar, {
                                segments: detailData?.breakdown?.segments || [],
                                activeTokens: detailData?.capacity?.active_tokens || 1,
                              }),
                            }),
                          ],
                        }),
                        // Row 2: Tools + Step Timeline
                        jsxs('div', {
                          className: 'grid grid-cols-1 md:grid-cols-2 gap-4',
                          children: [
                            // Tools used
                            jsxs('div', {
                              className: 'flex flex-col p-4 rounded-xl border border-white/10 bg-white/[0.02]',
                              children: [
                                jsx('div', { className: 'text-xs font-semibold text-white mb-2', children: '🛠️ 工具调用频次 (Tool Executions)' }),
                                (detailData?.tools || []).length === 0
                                  ? jsx('div', { className: 'text-xs text-[var(--ui-text-tertiary,#94a3b8)] py-4 text-center', children: '无工具调用记录' })
                                  : jsx('div', {
                                      className: 'flex flex-col gap-1.5 max-h-48 overflow-y-auto pr-1',
                                      children: (detailData?.tools || []).map((t) =>
                                        jsxs(
                                          'div',
                                          {
                                            className: 'flex items-center justify-between text-xs py-1 px-2 rounded bg-white/[0.02]',
                                            children: [
                                              jsx('span', { className: 'font-mono text-cyan-400', children: t.name }),
                                              jsxs('div', {
                                                className: 'flex items-center gap-2 font-mono text-[var(--ui-text-secondary,#cbd5e1)]',
                                                children: [
                                                  jsx('span', { children: `${t.calls} 次` }),
                                                  t.errors > 0 && jsx('span', { className: 'text-red-400', children: `(! ${t.errors})` }),
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
                            // Timeline summary
                            jsxs('div', {
                              className: 'flex flex-col p-4 rounded-xl border border-white/10 bg-white/[0.02]',
                              children: [
                                jsx('div', { className: 'text-xs font-semibold text-white mb-2', children: '⏱️ 演进时间线 (Timeline Steps)' }),
                                jsx('div', {
                                  className: 'flex flex-col gap-1.5 max-h-48 overflow-y-auto pr-1',
                                  children: (detailData?.timeline || []).slice(-15).map((step) =>
                                    jsxs(
                                      'div',
                                      {
                                        className: 'flex items-center justify-between text-[11px] py-1 px-2 rounded bg-white/[0.02]',
                                        children: [
                                          jsxs('div', {
                                            className: 'flex items-center gap-1.5 truncate pr-2',
                                            children: [
                                              jsx('span', { className: 'text-[var(--ui-text-tertiary,#64748b)] font-mono', children: `#${step.step}` }),
                                              jsx('span', {
                                                className: cn(
                                                  'font-semibold uppercase text-[10px] px-1 rounded',
                                                  step.role === 'user' ? 'text-amber-400 bg-amber-400/10' :
                                                  step.role === 'assistant' ? 'text-pink-400 bg-pink-400/10' : 'text-teal-400 bg-teal-400/10'
                                                ),
                                                children: step.role,
                                              }),
                                              jsx('span', { className: 'text-[var(--ui-text-secondary,#cbd5e1)] truncate', children: step.preview }),
                                            ],
                                          }),
                                          jsx('span', { className: 'font-mono text-[var(--ui-text-tertiary,#94a3b8)] shrink-0', children: fmtTokens(step.tokens) }),
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
    className: 'flex flex-col h-full w-full bg-[var(--ui-bg-base,#0b0f17)] text-white overflow-y-auto p-4 gap-4',
    children: [
      // Pane Header
      jsxs('div', {
        className: 'flex items-center justify-between pb-2 border-b border-white/10',
        children: [
          jsxs('div', {
            className: 'flex items-center gap-2',
            children: [
              jsx('span', { className: 'text-base', children: '⚡' }),
              jsx('span', { className: 'font-semibold text-xs tracking-wide text-white', children: 'Context 全景透视' }),
            ],
          }),
          jsx(Button, {
            variant: 'ghost',
            size: 'sm',
            className: 'h-6 text-[11px] px-1.5 text-neutral-400 hover:text-white',
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
                className: 'px-2.5 py-1.5 rounded-lg border border-white/5 bg-white/[0.02] flex flex-col gap-0.5',
                children: [
                  jsx('div', { className: 'text-[11px] font-medium text-white truncate', children: data?.session?.title || '未命名会话' }),
                  jsxs('div', {
                    className: 'text-[10px] text-[var(--ui-text-tertiary,#64748b)] font-mono flex items-center justify-between',
                    children: [
                      jsx('span', { children: data?.session?.model || 'model' }),
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
                    className: 'p-2.5 rounded-lg border border-white/5 bg-white/[0.02] flex flex-col',
                    children: [
                      jsx('span', { className: 'text-[10px] text-[var(--ui-text-tertiary,#94a3b8)]', children: 'Prompt 累计' }),
                      jsx('span', { className: 'font-bold font-mono text-white mt-0.5', children: fmtTokens(data?.tokens?.input_tokens || 0) }),
                    ],
                  }),
                  jsxs('div', {
                    className: 'p-2.5 rounded-lg border border-white/5 bg-white/[0.02] flex flex-col',
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
                  className: 'flex flex-col gap-1.5 p-3 rounded-lg border border-white/5 bg-white/[0.02]',
                  children: [
                    jsx('div', { className: 'text-xs font-semibold text-[var(--ui-text-secondary,#cbd5e1)]', children: '🛠️ 工具调用' }),
                    jsx('div', {
                      className: 'flex flex-wrap gap-1.5 mt-1',
                      children: data.tools.slice(0, 6).map((t) =>
                        jsxs(
                          'span',
                          {
                            className: 'px-2 py-0.5 rounded text-[10px] font-mono bg-white/5 border border-white/10 flex items-center gap-1',
                            children: [
                              jsx('span', { className: 'text-cyan-400', children: t.name }),
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
    className: 'flex items-center gap-1.5 px-2 py-0.5 text-[11px] font-mono rounded hover:bg-white/10 transition-colors',
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
      jsx('span', { className: 'text-[var(--ui-text-secondary,#cbd5e1)]', children: '⚡' }),
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
