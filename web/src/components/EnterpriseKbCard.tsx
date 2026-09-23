import { useEffect, useState } from "react";
import { Button } from "@nous-research/ui/ui/components/button";
import { Badge } from "@nous-research/ui/ui/components/badge";
import { Card } from "@nous-research/ui/ui/components/card";
import { Spinner } from "@nous-research/ui/ui/components/spinner";
import {
  api,
  type EnterpriseKbDataset,
  type EnterpriseKbStatusResponse,
} from "@/lib/api";
import { EnterpriseKbLoginModal } from "./EnterpriseKbLoginModal";
import { BookOpen, CheckSquare, LogOut, RefreshCw, Square } from "lucide-react";

interface Props {
  sessionId?: string;
}

export function EnterpriseKbCard({ sessionId }: Props) {
  const [status, setStatus] = useState<EnterpriseKbStatusResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [showLoginModal, setShowLoginModal] = useState(false);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);

  const fetchStatus = async () => {
    try {
      setLoading(true);
      const res = await api.getEnterpriseKbStatus();
      setStatus(res);
      // Default to selecting all datasets initially if none selected
      if (res.datasets && res.datasets.length > 0) {
        setSelectedIds(res.datasets.map((d) => d.id));
      }
    } catch {
      setStatus({ logged_in: false });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchStatus();
  }, []);

  // Sync selection with session whenever selectedIds or sessionId changes
  useEffect(() => {
    if (sessionId && status?.logged_in) {
      api.setSessionEnterpriseKbDatasets(sessionId, selectedIds).catch(() => {});
    }
  }, [sessionId, selectedIds, status?.logged_in]);

  const handleRefresh = async () => {
    setRefreshing(true);
    try {
      const res = await api.getEnterpriseKbDatasets();
      if (status) {
        setStatus({ ...status, datasets: res.datasets });
      }
    } catch (e) {
      console.warn("Failed to refresh datasets", e);
    } finally {
      setRefreshing(false);
    }
  };

  const handleLogout = async () => {
    try {
      await api.logoutEnterpriseKb();
      setStatus({ logged_in: false, datasets: [] });
      setSelectedIds([]);
    } catch (e) {
      console.warn("Logout failed", e);
    }
  };

  const toggleDataset = (id: string) => {
    setSelectedIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
    );
  };

  const selectAll = () => {
    if (!status?.datasets) return;
    setSelectedIds(status.datasets.map((d) => d.id));
  };

  const clearAll = () => {
    setSelectedIds([]);
  };

  const datasets = status?.datasets || [];

  return (
    <>
      <Card className="rounded-lg border border-border bg-card p-3 shadow-xs">
        <div className="flex items-center justify-between pb-2 border-b border-border/50">
          <div className="flex items-center gap-1.5 font-medium text-xs text-foreground">
            <BookOpen className="h-3.5 w-3.5 text-primary" />
            <span>企业知识库</span>
            {status?.logged_in && (
              <Badge tone="secondary" className="px-1 py-0 text-[10px] leading-tight">
                {selectedIds.length}/{datasets.length}
              </Badge>
            )}
          </div>

          {status?.logged_in ? (
            <div className="flex items-center gap-1">
              <button
                onClick={handleRefresh}
                disabled={refreshing}
                title="刷新知识库列表"
                className="p-1 text-text-secondary hover:text-foreground rounded"
              >
                <RefreshCw className={`h-3 w-3 ${refreshing ? "animate-spin" : ""}`} />
              </button>
              <button
                onClick={handleLogout}
                title="退出知识库登录"
                className="p-1 text-text-secondary hover:text-destructive rounded"
              >
                <LogOut className="h-3 w-3" />
              </button>
            </div>
          ) : null}
        </div>

        {loading ? (
          <div className="py-4 flex justify-center items-center">
            <Spinner className="h-4 w-4" />
          </div>
        ) : !status?.logged_in ? (
          <div className="pt-2 text-center">
            <p className="text-[11px] text-text-secondary mb-2">
              未连接企业知识库 (RAGFlow)
            </p>
            <Button
              outlined
              size="sm"
              onClick={() => setShowLoginModal(true)}
              className="w-full text-xs h-7"
            >
              登录企业知识库
            </Button>
          </div>
        ) : (
          <div className="pt-2">
            <div className="flex items-center justify-between text-[11px] text-text-secondary mb-1.5">
              <span className="truncate max-w-[120px]" title={status.username}>
                账号: {status.username}
              </span>
              <div className="flex items-center gap-1 text-[10px]">
                <button
                  onClick={selectAll}
                  className="hover:text-primary transition-colors cursor-pointer"
                >
                  全选
                </button>
                <span>/</span>
                <button
                  onClick={clearAll}
                  className="hover:text-primary transition-colors cursor-pointer"
                >
                  清空
                </button>
              </div>
            </div>

            {datasets.length === 0 ? (
              <div className="py-2 text-center text-[11px] text-text-secondary">
                当前账号名下无可用知识库
              </div>
            ) : (
              <div className="max-h-36 overflow-y-auto space-y-1 pr-0.5">
                {datasets.map((d: EnterpriseKbDataset) => {
                  const isChecked = selectedIds.includes(d.id);
                  return (
                    <div
                      key={d.id}
                      onClick={() => toggleDataset(d.id)}
                      className="flex items-start gap-1.5 p-1 rounded hover:bg-midground/30 cursor-pointer text-xs"
                    >
                      <button
                        type="button"
                        className="mt-0.5 text-text-secondary shrink-0"
                      >
                        {isChecked ? (
                          <CheckSquare className="h-3.5 w-3.5 text-primary" />
                        ) : (
                          <Square className="h-3.5 w-3.5" />
                        )}
                      </button>
                      <div className="min-w-0 flex-1">
                        <div className="truncate font-medium text-[11px] leading-tight text-foreground">
                          {d.name}
                        </div>
                        <div className="text-[10px] text-text-secondary">
                          {d.document_count} 篇文档
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}
      </Card>

      {showLoginModal && (
        <EnterpriseKbLoginModal
          onClose={() => setShowLoginModal(false)}
          onSuccess={(resp) => {
            setStatus({
              logged_in: true,
              username: resp.username,
              base_url: resp.base_url,
              datasets: resp.datasets,
            });
            if (resp.datasets && resp.datasets.length > 0) {
              setSelectedIds(resp.datasets.map((d) => d.id));
            }
          }}
        />
      )}
    </>
  );
}
