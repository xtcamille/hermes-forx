import { useState } from 'react'

import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { loginEnterpriseKb } from '@/hermes'
import { IconBook as BookOpen } from '@tabler/icons-react'
import { Loader2 } from '@/lib/icons'
import { $enterpriseKbStatus, switchToDefaultEnterpriseKb } from '@/store/enterprise-kb'
import { notify, notifyError } from '@/store/notifications'

export function EnterpriseKbLoginDialog({
  open,
  onOpenChange
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const currentStatus = $enterpriseKbStatus.get()
  const [baseUrl, setBaseUrl] = useState(() => currentStatus?.base_url || 'http://172.22.0.87')
  const [username, setUsername] = useState(() => (!currentStatus?.is_default && currentStatus?.raw_username ? currentStatus.raw_username : ''))
  const [password, setPassword] = useState('')
  const [loading, setLoading] = useState(false)
  const [errorMsg, setErrorMsg] = useState<string | null>(null)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!username.trim() || !password.trim()) {
      setErrorMsg('请输入知识库账号与密码')
      return
    }

    setLoading(true)
    setErrorMsg(null)
    try {
      const res = await loginEnterpriseKb(username.trim(), password.trim(), baseUrl.trim())
      $enterpriseKbStatus.set({
        logged_in: true,
        username: res.username,
        raw_username: res.raw_username,
        is_default: res.is_default,
        base_url: res.base_url,
        datasets: res.datasets
      })
      notify({
        kind: 'success',
        message: `已成功连接个人知识库 (${res.datasets?.length ?? 0} 个知识库已就绪)`
      })
      onOpenChange(false)
    } catch (err: any) {
      let msg = err?.message || '登录失败，请检查服务器地址与账号密码'
      try {
        const jsonMatch = msg.match(/\{.*\}$/)
        if (jsonMatch) {
          const parsed = JSON.parse(jsonMatch[0])
          if (parsed.detail) msg = parsed.detail
        }
      } catch {}
      setErrorMsg(msg)
      notifyError(new Error(msg), '企业知识库登录失败')
    } finally {
      setLoading(false)
    }
  }

  const handleResetDefault = async () => {
    setLoading(true)
    setErrorMsg(null)
    try {
      const ok = await switchToDefaultEnterpriseKb()
      if (ok) {
        notify({
          kind: 'success',
          message: '已恢复使用系统默认官方知识库'
        })
        onOpenChange(false)
      } else {
        setErrorMsg('恢复默认知识库失败')
      }
    } catch (err: any) {
      setErrorMsg(err?.message || '操作失败')
    } finally {
      setLoading(false)
    }
  }

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent bodyClassName="gap-4" className="max-w-md">
        <DialogHeader>
          <DialogTitle icon={BookOpen}>登录个人知识库</DialogTitle>
          <DialogDescription>
            连接 RAGFlow 企业知识库服务，登录个人账号以获取名下专属知识库数据
          </DialogDescription>
        </DialogHeader>

        {errorMsg && (
          <div className="rounded-xl border border-destructive/20 bg-destructive/10 p-3 text-xs text-destructive">
            {errorMsg}
          </div>
        )}

        <form className="grid gap-3" onSubmit={handleSubmit}>
          <div className="grid gap-1">
            <label className="text-xs font-medium text-muted-foreground">
              服务地址 (RAGFlow URL)
            </label>
            <Input
              className="font-mono text-sm"
              disabled={loading}
              onChange={e => setBaseUrl(e.target.value)}
              placeholder="http://172.22.0.87"
              value={baseUrl}
            />
          </div>

          <div className="grid gap-1">
            <label className="text-xs font-medium text-muted-foreground">
              知识库账号 / 邮箱
            </label>
            <Input
              autoFocus
              className="text-sm"
              disabled={loading}
              onChange={e => setUsername(e.target.value)}
              placeholder="输入 RAGFlow 用户名或邮箱"
              value={username}
            />
          </div>

          <div className="grid gap-1">
            <label className="text-xs font-medium text-muted-foreground">
              密码
            </label>
            <Input
              className="text-sm"
              disabled={loading}
              onChange={e => setPassword(e.target.value)}
              placeholder="输入知识库登录密码"
              type="password"
              value={password}
            />
          </div>

          <div className="flex items-center justify-between pt-1 text-xs">
            <button
              className="text-muted-foreground hover:text-foreground hover:underline cursor-pointer"
              disabled={loading}
              onClick={handleResetDefault}
              type="button"
            >
              恢复使用默认共享知识库
            </button>
          </div>

          <DialogFooter className="mt-2 gap-2">
            <Button
              disabled={loading}
              onClick={() => onOpenChange(false)}
              type="button"
              variant="outline"
            >
              取消
            </Button>
            <Button disabled={loading || !username.trim() || !password.trim()} type="submit">
              {loading ? (
                <>
                  <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                  验证并同步...
                </>
              ) : (
                '登录个人知识库'
              )}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
