import '@/styles.css'

import {
  AssistantRuntimeProvider,
  MessagePrimitive,
  type ThreadMessage,
  useExternalStoreRuntime
} from '@assistant-ui/react'
import { desktopColorSeeds, THEME_PRESET_PALETTES } from '@hermes/shared/theme-presets'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { useState } from 'react'
import { flushSync } from 'react-dom'
import { createRoot } from 'react-dom/client'
import { MemoryRouter } from 'react-router'

import { SessionStatusDot } from '@/app/chat/session-status-dot'
import { SidebarDateDivider } from '@/app/chat/sidebar/chrome'
import { ProfileRail } from '@/app/chat/sidebar/profile-switcher'
import { SidebarPinnedEmptyState } from '@/app/chat/sidebar/section-states'
import { useStatusbarContributions } from '@/app/contrib/panes'
import { OverlayNav } from '@/app/overlays/overlay-split-layout'
import { PageSearchShell } from '@/app/page-search-shell'
import { SidebarPanelLabel } from '@/app/shell/sidebar-label'
import { StatusbarControls } from '@/app/shell/statusbar-controls'
import { TitlebarIcon } from '@/app/shell/titlebar-icon'
import { Thread } from '@/components/assistant-ui/thread'
import { ThreadMessageList } from '@/components/assistant-ui/thread/list'
import { StickyHumanMessageContainer, USER_BUBBLE_BASE_CLASS } from '@/components/assistant-ui/thread/user-message'
import { group, split } from '@/components/pane-shell/tree/model'
import { TreeSplit } from '@/components/pane-shell/tree/renderer/tree-split'
import { Button } from '@/components/ui/button'
import { Codicon, codiconIcon } from '@/components/ui/codicon'
import { ContextMenu, ContextMenuTrigger } from '@/components/ui/context-menu'
import { PaneTab, PaneTabLabel, PaneTabStrip } from '@/components/ui/pane-tab'
import { SidebarMenuButton, SidebarProvider } from '@/components/ui/sidebar'
import { RootTooltipProvider } from '@/components/ui/tooltip'
import { registry } from '@/contrib/registry'
import { I18nProvider } from '@/i18n'
import { Activity, Command, FolderOpen, Hash, MessageCircle, ZapFilled } from '@/lib/icons'
import { $profiles } from '@/store/profile'

// Real primitives and stylesheet; only the sample labels and glass inputs are fixtures.
const params = new URLSearchParams(location.search)
const streamingReasoning = params.has('reasoning')
const toolActivity = params.has('tools')
const commandRun = params.get('tools') === 'run'
const shellControls = params.has('controls')
const queryClient = new QueryClient(
  shellControls ? { defaultOptions: { queries: { staleTime: Infinity } } } : undefined
)
const root = document.documentElement
root.classList.toggle('dark', !params.has('light'))
root.setAttribute('data-hermes-glass', '')
root.setAttribute('data-hermes-glass-scope', toolActivity ? 'sidebar' : 'window')
root.style.setProperty('--translucency-glass-keep', '40%')

if (shellControls) {
  $profiles.set([
    {
      display_name: 'ForX',
      has_env: false,
      is_default: true,
      model: null,
      name: 'default',
      path: '',
      provider: null,
      skill_count: 0
    }
  ])

  void Promise.all([
    import('../../../../plugins/forx-context/desktop/plugin.js?raw'),
    import('@/contrib/runtime-loader'),
    import('@/sdk')
  ]).then(([{ default: source }, { loadRuntimePlugin }, { host }]) => {
    const target = host.state.focusedStoredSessionId.get() || host.state.activeSessionId.get()
    queryClient.setQueryData(['forx-context', 'chip', target, host.state.profile.get()], {
      capacity: { active_tokens: 768, context_limit: 128_000, health_status: 'safe', usage_pct: 0.6 }
    })
    return loadRuntimePlugin(source, 'shell controls fixture')
  })
}

if (toolActivity) {
  const theme = THEME_PRESET_PALETTES.cupertino
  const colors = params.has('light') ? theme.colors : theme.darkColors
  for (const [key, value] of Object.entries(desktopColorSeeds(colors))) {
    root.style.setProperty(key, value)
  }
}

const sidebarLayout = params.has('sidebar') ? split('row', [group(['sessions']), group(['workspace'])]) : null

if (sidebarLayout) {
  registry.registerMany([
    { area: 'panes', data: { placement: 'left', width: '14rem' }, id: 'sessions', render: () => null, title: 'Sessions' },
    { area: 'panes', data: { placement: 'main', uncloseable: true }, id: 'workspace', render: () => null, title: 'Chat' }
  ])
}

const messages = Array.from({ length: 6 }, (_, turn) => [
  {
    id: `user-${turn}`,
    role: 'user',
    attachments: [],
    createdAt: new Date(0),
    content: [{ type: 'text', text: `Prompt ${turn}` }],
    metadata: { custom: {} }
  },
  {
    id: `assistant-${turn}`,
    role: 'assistant',
    createdAt: new Date(0),
    content: [{ type: 'text', text: `Reply ${turn}` }],
    status: { type: 'complete', reason: 'stop' },
    metadata: { custom: {}, unstable_state: null, unstable_annotations: [], unstable_data: [], steps: [] }
  }
]).flat() as ThreadMessage[]

const firstTurn = [
  {
    ...messages[0],
    content: [{ type: 'text', text: '这是一条已发送的多行消息。\n正在等待助手回复。' }]
  },
  {
    ...messages[1],
    content: [
      {
        type: 'reasoning',
        text: Array.from({ length: 16 }, (_, index) => `Reasoning paragraph ${index + 1}`).join('\n\n')
      }
    ],
    status: { type: 'running' }
  }
] as ThreadMessage[]

const targetTool = 'forx_publish_check'
const describeArgs = { names: [targetTool] }
const callArgs = { calls: [{ name: targetTool, arguments: {} }] }
const toolsTurn = [
  { ...messages[0], content: [{ type: 'text', text: '检查项目的发布工具。' }] },
  {
    ...messages[1],
    content: [
      { type: 'text', text: '先查看工具说明。' },
      {
        type: 'tool-call', toolCallId: 'describe', toolName: 'tool_describe', args: describeArgs,
        argsText: JSON.stringify(describeArgs), result: { tools: { [targetTool]: { description: '检查插件目录' } } }
      },
      { type: 'text', text: '运行一次目录检查。' },
      {
        type: 'tool-call', toolCallId: 'check', toolName: 'tool_call', args: callArgs,
        argsText: JSON.stringify(callArgs), isError: true, result: { error: '请提供插件目录。' }
      }
    ]
  }
] as ThreadMessage[]

const script = String.raw`pub = r"C:\Program Files\ForX\resources\backend\plugins\forx-publisher\publisher.py"
with open(pub, encoding="utf-8") as source:
    print(source.read())`
const commandTurn = [
  toolsTurn[0],
  {
    ...messages[1],
    status: { type: 'running' },
    content: [
      { type: 'reasoning', text: '先读取发布脚本，再核对仓库状态。' },
      ...['git status', 'git log -1'].map(command => ({
        type: 'tool-call',
        toolCallId: command,
        toolName: 'terminal',
        args: { command },
        argsText: JSON.stringify({ command }),
        result: { exit_code: 0 }
      })),
      {
        type: 'tool-call',
        toolCallId: 'script',
        toolName: 'execute_code',
        args: { code: script },
        argsText: JSON.stringify({ code: script }),
        result: { output: '读取成功', stdout_bytes_total: 12, duration_s: 0.038 }
      }
    ]
  }
] as ThreadMessage[]

function User() {
  const [expanded, setExpanded] = useState(false)

  return (
    <StickyHumanMessageContainer
      attachments={
        <div data-testid="attachment" style={{ height: 40 }}>
          Attachment
        </div>
      }
    >
      <button
        className={USER_BUBBLE_BASE_CLASS}
        onClick={() => setExpanded(value => !value)}
        style={{ height: expanded ? 140 : 48 }}
      >
        A user prompt — click to change its height
      </button>
    </StickyHumanMessageContainer>
  )
}

function Assistant() {
  return (
    <MessagePrimitive.Root data-slot="aui_assistant-message-root">
      <div data-testid="reply-marker" style={{ height: 900, background: '#ff0000' }}>
        Scrolling reply
      </div>
    </MessagePrimitive.Root>
  )
}

const components = { UserMessage: User, AssistantMessage: Assistant }

function Transcript({ id }: { id: string }) {
  const [currentMessages, setMessages] = useState(() => {
    if (toolActivity) {
      return commandRun ? commandTurn : toolsTurn
    }
    if (streamingReasoning) {
      return firstTurn
    }

    return params.has('preceding')
      ? ([{ ...messages[1], id: 'standalone' }, ...messages] as ThreadMessage[])
      : messages
  })

  const lastMessage = currentMessages.at(-1)
  const running =
    streamingReasoning || (commandRun && lastMessage?.role === 'assistant' && lastMessage.status.type === 'running')
  const runtime = useExternalStoreRuntime<ThreadMessage>({
    messages: currentMessages,
    isRunning: running,
    onNew: async () => {},
    onEdit: async () => {}
  })

  const realMessages = toolActivity || streamingReasoning || params.has('real')

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <div>
        {commandRun && (
          <button
            onClick={() =>
              setMessages(previous =>
                previous.map(message =>
                  message.role === 'assistant' ? { ...message, status: { type: 'complete', reason: 'stop' } } : message
                )
              )
            }
            type="button"
          >
            Finish run
          </button>
        )}
        <button
          data-testid={`${id}-append`}
          onClick={() =>
            flushSync(() =>
              setMessages(previous => [
                ...previous,
                { ...messages[1], id: `appended-${previous.length}` } as ThreadMessage
              ])
            )
          }
        >
          Append reply
        </button>
        <div data-testid={id} style={{ height: 430, width: 480 }}>
          {realMessages ? (
            <Thread onCancel={running ? () => {} : undefined} sessionKey={id} />
          ) : (
            <ThreadMessageList components={components} sessionKey={id} />
          )}
        </div>
      </div>
    </AssistantRuntimeProvider>
  )
}

function ShellControlsFixture() {
  const contributedItems = useStatusbarContributions('right')
  const [pageTab, setPageTab] = useState('plugins')

  return (
    <>
      <SidebarProvider className="min-h-0 items-start">
        <div className="w-56">
          <PaneTabStrip data-testid="shell-tabs">
            <PaneTab active>
              <PaneTabLabel>Sessions</PaneTabLabel>
            </PaneTab>
            <PaneTab>
              <PaneTabLabel>Bots</PaneTabLabel>
            </PaneTab>
          </PaneTabStrip>
          <ContextMenu>
            <ContextMenuTrigger asChild>
              <SidebarMenuButton size="sm">
                <Codicon name="robot" />
                <span>New session</span>
              </SidebarMenuButton>
            </ContextMenuTrigger>
          </ContextMenu>
          <SidebarMenuButton size="sm">
            <MessageCircle />
            <span>Messaging</span>
          </SidebarMenuButton>
          <SidebarPanelLabel>Pinned</SidebarPanelLabel>
          <SidebarPinnedEmptyState />
          <SidebarPanelLabel>Recent sessions</SidebarPanelLabel>
          <SidebarDateDivider label="This month" />
          <SidebarDateDivider label="October" />
          <ProfileRail />
        </div>
        <Button aria-label="Settings" size="icon-titlebar" variant="ghost">
          <TitlebarIcon name="settings-gear" />
        </Button>
      </SidebarProvider>
      <StatusbarControls
        items={[
          ...contributedItems,
          { icon: <ZapFilled />, id: 'approval', label: 'Off' },
          { icon: <Hash />, id: 'version', label: 'v1.2.3', variant: 'text' }
        ]}
        leftItems={[
          { className: 'w-7 justify-center px-0', icon: <Command />, id: 'command-center' },
          { detail: 'Ready', icon: <Activity />, id: 'gateway', label: 'Gateway' },
          { icon: <FolderOpen />, id: 'workspace', label: 'zxt' }
        ]}
      />
      <PageSearchShell
        activeTab={pageTab}
        className="h-auto"
        data-testid="page-nav"
        onSearchChange={() => {}}
        onTabChange={setPageTab}
        searchHidden
        searchPlaceholder=""
        searchValue=""
        tabs={[
          { id: 'skills', label: 'Skills' },
          { id: 'plugins', label: 'Plugins' }
        ]}
      >
        {null}
      </PageSearchShell>
      <div data-testid="overlay-nav">
        <OverlayNav
          groups={[
            { active: true, icon: codiconIcon('account'), id: 'appearance', label: 'Appearance', onSelect: () => {} }
          ]}
        />
      </div>
    </>
  )
}

createRoot(document.getElementById('root')!).render(
  <QueryClientProvider client={queryClient}>
    <I18nProvider configClient={toolActivity ? null : undefined} initialLocale={toolActivity ? 'zh' : undefined}>
      <RootTooltipProvider>
        <MemoryRouter>
          {shellControls && <ShellControlsFixture />}
          {sidebarLayout && (
            <div className="flex h-64">
              <TreeSplit node={sidebarLayout} root rootRow topEdge />
            </div>
          )}
          <div style={{ padding: 40 }}>
            <PaneTabStrip>
              <PaneTab
                active
                data-testid="active-tab"
                onClose={() => document.body.setAttribute('data-closed', 'true')}
              >
                <SessionStatusDot className="ml-2 -mr-1 shrink-0" storedSessionId={null} />
                <PaneTabLabel as="button" onClick={() => document.body.setAttribute('data-activated', 'true')}>
                  修复 FORX 桌面端标签栏上文字和关闭按钮重叠的问题
                </PaneTabLabel>
              </PaneTab>
              <PaneTab data-testid="idle-tab" dirty onClose={() => {}}>
                <PaneTabLabel>Another long session title with unsaved changes</PaneTabLabel>
              </PaneTab>
              <PaneTab data-testid="fixed-tab">
                <PaneTabLabel>Sessions</PaneTabLabel>
              </PaneTab>
              <PaneTab data-testid="short-tab" onClose={() => {}}>
                <PaneTabLabel>X</PaneTabLabel>
              </PaneTab>
              <PaneTab data-testid="selected-tab" onClose={() => {}} selected>
                <PaneTabLabel>Selected</PaneTabLabel>
              </PaneTab>
            </PaneTabStrip>
            <div style={{ display: 'flex', gap: 30, marginTop: 40 }}>
              <Transcript id="first-transcript" />
              <Transcript id="second-transcript" />
            </div>
          </div>
        </MemoryRouter>
      </RootTooltipProvider>
    </I18nProvider>
  </QueryClientProvider>
)
