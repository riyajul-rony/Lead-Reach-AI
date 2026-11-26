"use client";

import { useCallback, useEffect, useState } from "react";
import { Globe, CheckCircle2, AlertCircle, RefreshCw, Trash2, Star, Plus, Loader2 } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

interface TrackingDomainItem {
  id: string;
  domain: string;
  cname_target: string;
  status: "pending" | "verified" | "failed";
  is_default: boolean;
  last_checked_at?: string | null;
  last_error?: string | null;
  verified_at?: string | null;
}

export function TrackingDomainsCard() {
  const [domains, setDomains] = useState<TrackingDomainItem[]>([]);
  const [cnameTarget, setCnameTarget] = useState<string>("");
  const [newDomain, setNewDomain] = useState("");
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const loadDomains = useCallback(async () => {
    setLoading(true);
    setErrorMsg(null);
    try {
      const res = await fetch("/api/v1/tracking-domains");
      const json = await res.json();
      if (!res.ok) {
        setErrorMsg(json.error || "Failed to load tracking domains.");
        return;
      }
      setDomains(json.data?.items || []);
      setCnameTarget(json.data?.cnameTarget || "");
    } catch {
      setErrorMsg("Unable to reach server while loading tracking domains.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadDomains();
  }, [loadDomains]);

  const handleAdd = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newDomain.trim() || submitting) return;
    setSubmitting(true);
    setErrorMsg(null);
    try {
      const res = await fetch("/api/v1/tracking-domains", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ domain: newDomain.trim() }),
      });
      const json = await res.json();
      if (!res.ok) {
        setErrorMsg(json.error || "Could not add domain.");
        return;
      }
      setNewDomain("");
      await loadDomains();
    } catch {
      setErrorMsg("Network error adding domain.");
    } finally {
      setSubmitting(false);
    }
  };

  const handleVerify = async (id: string) => {
    setBusyId(id);
    setErrorMsg(null);
    try {
      const res = await fetch(`/api/v1/tracking-domains/${id}/verify`, {
        method: "POST",
      });
      const json = await res.json();
      if (!res.ok) {
        setErrorMsg(json.error || "DNS check failed.");
      }
      await loadDomains();
    } catch {
      setErrorMsg("Network error verifying DNS.");
    } finally {
      setBusyId(null);
    }
  };

  const handleSetDefault = async (id: string) => {
    setBusyId(id);
    setErrorMsg(null);
    try {
      const res = await fetch(`/api/v1/tracking-domains/${id}`, {
        method: "PATCH",
      });
      const json = await res.json();
      if (!res.ok) {
        setErrorMsg(json.error || "Failed to set default.");
        return;
      }
      await loadDomains();
    } finally {
      setBusyId(null);
    }
  };

  const handleDelete = async (id: string) => {
    setBusyId(id);
    setErrorMsg(null);
    try {
      const res = await fetch(`/api/v1/tracking-domains/${id}`, {
        method: "DELETE",
      });
      if (!res.ok) {
        const json = await res.json().catch(() => ({}));
        setErrorMsg(json.error || "Failed to remove domain.");
        return;
      }
      await loadDomains();
    } finally {
      setBusyId(null);
    }
  };

  return (
    <Card className="hover:border-borderStrong transition-colors duration-150">
      <CardContent className="p-5 space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 flex items-center justify-center rounded-[8px] bg-primary/10 text-primary border border-primary/20 shrink-0">
              <Globe size={20} />
            </div>
            <div>
              <div className="font-semibold text-sm text-fg">
                Custom Tracking Domains (CNAME)
              </div>
              <div className="text-xs text-muted">
                Brand open, click, and unsubscribe links with your own subdomain (e.g.{" "}
                <code className="font-mono text-fg">track.yourdomain.com</code>) for higher deliverability.
              </div>
            </div>
          </div>
          <Badge variant="neutral" size="sm">
            {domains.filter((d) => d.status === "verified").length} Verified
          </Badge>
        </div>

        {/* CNAME Instructions */}
        <div className="p-3 rounded-lg border border-border bg-bgSubtle text-xs space-y-1">
          <div className="font-semibold text-fg">DNS Setup Instructions</div>
          <p className="text-muted">
            Create a <strong className="text-fg">CNAME</strong> record at your DNS provider pointing your subdomain (e.g.{" "}
            <code className="font-mono text-fg">track</code>) to:{" "}
            <code className="font-mono text-fg bg-surface px-1.5 py-0.5 rounded border border-border">
              {cnameTarget || "your-app-domain"}
            </code>
          </p>
        </div>

        {/* Add Form */}
        <form onSubmit={handleAdd} className="flex flex-col sm:flex-row gap-2">
          <input
            type="text"
            value={newDomain}
            onChange={(e) => setNewDomain(e.target.value)}
            placeholder="track.yourdomain.com"
            className="input flex-1 text-xs"
            disabled={submitting}
          />
          <Button
            type="submit"
            variant="primary"
            size="sm"
            disabled={submitting || !newDomain.trim()}
            icon={submitting ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />}
          >
            Add Domain
          </Button>
        </form>

        {errorMsg && (
          <div className="p-2.5 rounded-lg border border-rose-500/30 bg-rose-500/10 text-xs text-rose-700 dark:text-rose-300 flex items-center gap-2">
            <AlertCircle size={14} className="shrink-0" />
            <span>{errorMsg}</span>
          </div>
        )}

        {/* List / Loading / Empty states */}
        {loading ? (
          <div className="flex items-center gap-2 py-4 text-xs text-muted">
            <Loader2 size={14} className="animate-spin" />
            <span>Loading tracking domains...</span>
          </div>
        ) : domains.length === 0 ? (
          <div className="py-4 text-center text-xs text-muted border border-dashed border-border rounded-lg">
            No custom tracking domains added yet. Campaigns use the default application domain until a verified CNAME is configured.
          </div>
        ) : (
          <div className="space-y-2">
            {domains.map((d) => (
              <div
                key={d.id}
                className="p-3 rounded-lg border border-border bg-bgSubtle flex flex-col sm:flex-row sm:items-center justify-between gap-3"
              >
                <div className="space-y-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-mono text-xs font-semibold text-fg truncate">
                      {d.domain}
                    </span>
                    <Badge
                      variant={
                        d.status === "verified"
                          ? "success"
                          : d.status === "failed"
                          ? "danger"
                          : "warning"
                      }
                      size="sm"
                    >
                      {d.status === "verified" ? (
                        <span className="inline-flex items-center gap-1">
                          <CheckCircle2 size={11} /> Verified
                        </span>
                      ) : d.status === "failed" ? (
                        "Failed"
                      ) : (
                        "Pending DNS"
                      )}
                    </Badge>
                    {d.is_default && (
                      <Badge variant="accent" size="sm">
                        Default
                      </Badge>
                    )}
                  </div>
                  <div className="text-[11px] text-muted font-mono truncate">
                    CNAME &rarr; {d.cname_target}
                  </div>
                  {d.last_error && (
                    <div className="text-[11px] text-rose-600 dark:text-rose-400">
                      {d.last_error}
                    </div>
                  )}
                </div>

                <div className="flex items-center gap-2 shrink-0">
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    onClick={() => handleVerify(d.id)}
                    disabled={busyId === d.id}
                    icon={
                      busyId === d.id ? (
                        <Loader2 size={13} className="animate-spin" />
                      ) : (
                        <RefreshCw size={13} />
                      )
                    }
                  >
                    Verify DNS
                  </Button>
                  {d.status === "verified" && !d.is_default && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => handleSetDefault(d.id)}
                      disabled={busyId === d.id}
                      icon={<Star size={13} />}
                    >
                      Set Default
                    </Button>
                  )}
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => handleDelete(d.id)}
                    disabled={busyId === d.id}
                    icon={<Trash2 size={13} />}
                  >
                    Remove
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
