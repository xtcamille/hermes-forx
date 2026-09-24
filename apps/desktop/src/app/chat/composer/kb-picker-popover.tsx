import { useStore } from '@nanostores/react'
import { useEffect, useState } from 'react'

import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { Tip } from '@/components/ui/tooltip'
import type { EnterpriseKbDataset } from '@/hermes'
import {
  IconBook as BookOpen,
  IconCheck as Check,
  IconChevronDown as ChevronDown,
  // IconLogout as LogOut,
  IconRefresh as RefreshCw
} from '@tabler/icons-react'
import { cn } from '@/lib/utils'
import {
  $enterpriseKbStatus,
  $selectedDatasetsBySession,
  getSelectedDatasetsForSession,
  openKbLoginDialog,
  refreshEnterpriseKbStatus,
  setSelectedDatasetsForSession
} from '@/store/enterprise-kb'
// import { logoutEnterpriseKb } from '@/hermes'

const PILL = cn(
  'h-(--composer-control-size) min-w-0 max-w-44 shrink gap-1 rounded-md px-2 text-xs font-normal',
  'text-(--ui-text-tertiary) hover:bg-(--chrome-action-hover) hover:text-foreground'
)

export function KbPickerPopover({
  disabled,
  sessionId,
  alternateSessionId
}: {
  disabled: boolean
  sessionId: string | null | undefined
  alternateSessionId?: string | null | undefined
}) {
  const status = useStore($enterpriseKbStatus)
  useStore($selectedDatasetsBySession)
  const [refreshing, setRefreshing] = useState(false)

  useEffect(() => {
    void refreshEnterpriseKbStatus()
  }, [])

  const datasets = status?.datasets || []
  const selectedIds = getSelectedDatasetsForSession(sessionId, alternateSessionId)

  const handleToggle = (id: string, e: React.MouseEvent) => {
    e.stopPropagation()
    const next = selectedIds.includes(id)
      ? selectedIds.filter(x => x !== id)
      : [...selectedIds, id]
    setSelectedDatasetsForSession(sessionId, next, alternateSessionId)
  }

  const handleSelectAll = (e: React.MouseEvent) => {
    e.stopPropagation()
    setSelectedDatasetsForSession(sessionId, datasets.map(d => d.id), alternateSessionId)
  }

  const handleClearAll = (e: React.MouseEvent) => {
    e.stopPropagation()
    setSelectedDatasetsForSession(sessionId, [], alternateSessionId)
  }

  const handleRefresh = async (e: React.MouseEvent) => {
    e.stopPropagation()
    setRefreshing(true)
    try {
      await refreshEnterpriseKbStatus()
    } finally {
      setRefreshing(false)
    }
  }

  /*
  const handleLogout = async (e: React.MouseEvent) => {
    e.stopPropagation()
    try {
      await logoutEnterpriseKb()
      $enterpriseKbStatus.set({ logged_in: false, datasets: [] })
    } catch (err) {
      console.warn('Logout failed:', err)
    }
  }
  */

  if (!status?.logged_in) {
    return (
      <Tip label="未登录企业知识库 (RAGFlow)，点击登录" side="top">
        <Button
          className={PILL}
          disabled={disabled}
          onClick={() => openKbLoginDialog()}
          size="sm"
          type="button"
          variant="ghost"
        >
          <BookOpen className="size-3.5 shrink-0 opacity-70 text-primary" />
          <span className="truncate">知识库</span>
        </Button>
      </Tip>
    )
  }

  return (
    <DropdownMenu>
      <Tip label="选择本次对话使用的企业知识库" side="top">
        <DropdownMenuTrigger asChild>
          <Button className={PILL} disabled={disabled} size="sm" type="button" variant="ghost">
            <BookOpen className="size-3.5 shrink-0 text-primary" />
            <span className="truncate">
              知识库 ({selectedIds.length}/{datasets.length})
            </span>
            <ChevronDown className="size-2.5 shrink-0 opacity-50" />
          </Button>
        </DropdownMenuTrigger>
      </Tip>

      <DropdownMenuContent align="start" className="w-64 p-1.5" side="top">
        <div className="flex items-center justify-between px-2 py-1 text-xs font-semibold text-foreground">
          <div className="flex items-center gap-1.5 truncate">
            <BookOpen className="size-3.5 text-primary" />
            <span className="truncate">企业知识库</span>
          </div>
          <div className="flex items-center gap-1 text-[11px] font-normal text-muted-foreground">
            <button
              className="hover:text-foreground cursor-pointer px-1 py-0.5 rounded"
              onClick={handleRefresh}
              title="刷新知识库"
            >
              <RefreshCw className={cn('size-3', refreshing && 'animate-spin')} />
            </button>
            {/*
            <button
              className="hover:text-destructive cursor-pointer px-1 py-0.5 rounded"
              onClick={handleLogout}
              title="退出登录"
            >
              <LogOut className="size-3" />
            </button>
            */}
          </div>
        </div>

        <div className="flex items-center justify-between px-2 pb-1.5 text-[11px] text-muted-foreground border-b border-border/50">
          <span className="truncate max-w-[120px]" title={(!status.username || status.username === 'admin@zkjg.com') ? '默认账户' : status.username}>
            账号: {(!status.username || status.username === 'admin@zkjg.com') ? '默认账户' : status.username}
          </span>
          <div className="flex items-center gap-1 text-[10px]">
            <button
              className="text-primary hover:underline cursor-pointer"
              onClick={handleSelectAll}
            >
              全选
            </button>
            <span>/</span>
            <button
              className="hover:underline cursor-pointer"
              onClick={handleClearAll}
            >
              清空
            </button>
          </div>
        </div>

        <div className="max-h-48 overflow-y-auto py-1 space-y-0.5">
          {datasets.length === 0 ? (
            <div className="px-2 py-3 text-center text-xs text-muted-foreground">
              当前账号下没有可用知识库
            </div>
          ) : (
            datasets.map((d: EnterpriseKbDataset) => {
              const selected = selectedIds.includes(d.id)
              return (
                <div
                  className={cn(
                    'flex items-center justify-between gap-2 px-2 py-1.5 text-xs rounded-md cursor-pointer select-none',
                    selected
                      ? 'bg-accent text-accent-foreground font-medium'
                      : 'hover:bg-muted text-foreground'
                  )}
                  key={d.id}
                  onClick={e => handleToggle(d.id, e)}
                >
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-xs">{d.name}</div>
                    <div className="text-[10px] text-muted-foreground">
                      {d.document_count} 篇文档
                    </div>
                  </div>
                  {selected && <Check className="size-3.5 text-primary shrink-0" />}
                </div>
              )
            })
          )}
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
