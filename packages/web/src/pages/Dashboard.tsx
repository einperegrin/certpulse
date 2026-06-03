import { useQuery } from "@tanstack/react-query";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "../components/ui/card";
import { DomainTable } from "../components/DomainTable";
import { api, type DomainRow } from "../lib/api";
import { Activity, AlertCircle, Globe, ShieldCheck, XCircle } from "lucide-react";

interface StatCardProps {
  label: string;
  value: number;
  hint?: string;
  icon: React.ReactNode;
  tone?: "default" | "warning" | "danger" | "success";
}

function StatCard({ label, value, hint, icon, tone = "default" }: StatCardProps) {
  const toneRing: Record<string, string> = {
    default: "ring-slate-200",
    warning: "ring-amber-200",
    danger: "ring-rose-200",
    success: "ring-emerald-200",
  };
  const toneIcon: Record<string, string> = {
    default: "text-slate-500",
    warning: "text-amber-500",
    danger: "text-rose-500",
    success: "text-emerald-500",
  };
  return (
    <Card className={`ring-1 ${toneRing[tone]}`}>
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
        <CardTitle>{label}</CardTitle>
        <span className={toneIcon[tone]}>{icon}</span>
      </CardHeader>
      <CardContent>
        <div className="text-3xl font-semibold tracking-tight text-slate-900">
          {value}
        </div>
        {hint && <p className="mt-1 text-xs text-slate-500">{hint}</p>}
      </CardContent>
    </Card>
  );
}

export function Dashboard() {
  const dashboard = useQuery({
    queryKey: ["dashboard"],
    queryFn: () => api.dashboard(),
  });

  const domains = useQuery({
    queryKey: ["domains"],
    queryFn: async () => {
      const r = await api.listDomains();
      return r.domains;
    },
  });

  const summary = dashboard.data;
  const rows: DomainRow[] = domains.data ?? summary?.domains ?? [];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-slate-900">
          Dashboard
        </h1>
        <p className="text-sm text-slate-500">
          Self-hosted SSL certificate and domain expiry monitoring.
        </p>
      </div>

      <div>
        <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-slate-500">
          TLS certificates
        </h2>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <StatCard
            label="Total Domains"
            value={summary?.total ?? rows.length}
            hint="Being monitored"
            icon={<Activity className="h-5 w-5" />}
          />
          <StatCard
            label="Cert Expiring Soon"
            value={summary?.expiringSoon ?? 0}
            hint="≤ 30 days remaining"
            tone="warning"
            icon={<AlertCircle className="h-5 w-5" />}
          />
          <StatCard
            label="Cert Expired"
            value={summary?.expired ?? 0}
            hint="Cert past expiry"
            tone="danger"
            icon={<XCircle className="h-5 w-5" />}
          />
          <StatCard
            label="Healthy"
            value={summary?.healthy ?? 0}
            hint="> 30 days remaining"
            tone="success"
            icon={<ShieldCheck className="h-5 w-5" />}
          />
        </div>
      </div>

      <div>
        <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-slate-500">
          Domain registration
        </h2>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-2">
          <StatCard
            label="Domain Expiring Soon"
            value={summary?.domainExpiringSoon ?? 0}
            hint="≤ 30 days remaining"
            tone="warning"
            icon={<Globe className="h-5 w-5" />}
          />
          <StatCard
            label="Domain Expired"
            value={summary?.domainExpired ?? 0}
            hint="Registration past expiry"
            tone="danger"
            icon={<Globe className="h-5 w-5" />}
          />
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Domains</CardTitle>
        </CardHeader>
        <CardContent>
          {dashboard.isLoading || domains.isLoading ? (
            <p className="py-8 text-center text-sm text-slate-500">Loading…</p>
          ) : (
            <DomainTable rows={rows} />
          )}
        </CardContent>
      </Card>
    </div>
  );
}
