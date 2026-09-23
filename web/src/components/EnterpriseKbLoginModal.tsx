import { useState } from "react";
import { X } from "lucide-react";
import { Button } from "@nous-research/ui/ui/components/button";
import { Spinner } from "@nous-research/ui/ui/components/spinner";
import { H2 } from "@nous-research/ui/ui/components/typography/h2";
import { Input } from "@nous-research/ui/ui/components/input";
import { api, type EnterpriseKbLoginResponse } from "@/lib/api";
import { errorMessage } from "@/lib/api-error";

interface Props {
  onClose: () => void;
  onSuccess: (resp: EnterpriseKbLoginResponse) => void;
}

export function EnterpriseKbLoginModal({ onClose, onSuccess }: Props) {
  const [baseUrl, setBaseUrl] = useState("http://172.22.0.87");
  const [username, setUsername] = useState("admin@zkjg.com");
  const [password, setPassword] = useState("123");
  const [loading, setLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!username.trim() || !password.trim()) {
      setErrorMsg("请输入账号与密码");
      return;
    }

    setLoading(true);
    setErrorMsg(null);
    try {
      const resp = await api.loginEnterpriseKb(username.trim(), password.trim(), baseUrl.trim());
      onSuccess(resp);
      onClose();
    } catch (err) {
      setErrorMsg(errorMessage(err) || "登录失败，请检查服务器地址与账号密码");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-xs p-4">
      <div className="relative w-full max-w-md rounded-xl border border-border bg-card p-6 shadow-2xl">
        <button
          onClick={onClose}
          disabled={loading}
          className="absolute top-4 right-4 text-text-secondary hover:text-foreground"
          aria-label="关闭"
        >
          <X className="h-5 w-5" />
        </button>

        <div className="mb-5 flex items-center gap-2">
          <span className="text-2xl">📚</span>
          <div>
            <H2 className="text-lg font-semibold leading-tight text-foreground">登录企业知识库</H2>
            <p className="text-xs text-text-secondary">连接并授权 RAGFlow 企业知识库服务</p>
          </div>
        </div>

        {errorMsg && (
          <div className="mb-4 rounded-lg bg-destructive/10 border border-destructive/20 p-3 text-xs text-destructive">
            {errorMsg}
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="mb-1 block text-xs font-medium text-text-secondary">
              服务地址 (RAGFlow URL)
            </label>
            <Input
              type="text"
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              placeholder="http://172.22.0.87"
              disabled={loading}
              className="text-sm font-mono"
            />
          </div>

          <div>
            <label className="mb-1 block text-xs font-medium text-text-secondary">
              账号 / 邮箱
            </label>
            <Input
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="name@company.com"
              disabled={loading}
              autoFocus
              className="text-sm"
            />
          </div>

          <div>
            <label className="mb-1 block text-xs font-medium text-text-secondary">
              密码
            </label>
            <Input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••"
              disabled={loading}
              className="text-sm"
            />
          </div>

          <div className="pt-2 flex justify-end gap-2">
            <Button
              type="button"
              outlined
              onClick={onClose}
              disabled={loading}
              className="text-xs"
            >
              取消
            </Button>
            <Button
              type="submit"
              disabled={loading}
              className="text-xs flex items-center gap-1.5"
            >
              {loading ? (
                <>
                  <Spinner className="h-3.5 w-3.5" />
                  <span>正在验证并拉取...</span>
                </>
              ) : (
                "登录并同步知识库"
              )}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}
