import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useParams, Link } from "react-router-dom";
import {
  ArrowLeft,
  RefreshCw,
  Trash2,
  Loader2,
  ShieldCheck,
} from "lucide-react";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "../components/ui/card";
import { Button } from "../components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../components/ui/table";
import { StatusBadge } from "../components/StatusBadge";
import { api } from "../lib/api";
import { formatDate, formatDistanceToNowStrict } from "../lib/format";

export function DomainDetail() {
  const { id } = useParams<{ id: string }>();
  const domainId = parseInt(id ?? "0", 10);
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const detail = useQuery({
    queryKey: ["domain", domainId],
    queryFn: () => api.getDomain(domainId),
    enabled: !Number.isNaN(domainId) && domainId > 0,
  });

  const checkMutation = useMutation({
    mutationFn: () => api.checkNow(domainId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["domain", domainId] });
      queryClient.invalidateQueries({ queryKey: ["dashboard"] });
      queryClient.invalidateQueries({ queryKey: ["domains"] });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: () => api.deleteDomain(domainId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["dashboard"] });
      queryClient.invalidateQueries({ queryKey: ["domains"] });
      navigate("/");
    },
  });

  if (detail.isLoading) {
    return (
      <p className="py-8 text-center text-sm text-slate-500">Loading…</p>
    );
  }
  if (detail.isError) {
    return (
      <div className="space-y-4">
        <Link to="/" className="inline-flex items-center gap-1 text-sm text-sky-600">
          <ArrowLeft className="h-4 w-4" /> Back to dashboard
        </Link>
        <p className="text-sm text-red-600">
          {(detail.error as Error).message}
        </p>
      </div>
    );
  }
  if (!detail.data) return null;
  const { domain, checks } = detail.data;
  const latest = checks[0];
  const days = latest?.daysRemaining ?? null;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <Link
          to="/"
          className="inline-flex items-center gap-1 text-sm text-sky-600"
        >
          <ArrowLeft className="h-4 w-4" /> Dashboard
        </Link>
        <div className="flex gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => checkMutation.mutate()}
            disabled={checkMutation.isPending}
          >
            {checkMutation.isPending ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <RefreshCw className="h-4 w-4" />
            )}
            Check Now
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              if (confirm(`Remove ${domain.hostname}?`)) {
                deleteMutation.mutate();
              }
            }}
          >
            <Trash2 className="h-4 w-4 text-rose-500" /> Delete
          </Button>
        </div>
      </div>

      <div className="flex items-center gap-3">
        <ShieldCheck className="h-8 w-8 text-sky-600" />
        <div>
          <h1 className="font-mono text-2xl font-semibold text-slate-900">
            {domain.hostname}
            <span className="ml-1 text-slate-400">:{domain.port}</span>
          </h1>
          <div className="mt-1 flex items-center gap-2 text-sm text-slate-500">
            <StatusBadge daysRemaining={days} />
            <span>
              {days === null || days === undefined
                ? "Never checked"
                : days > 0
                ? `${days} days remaining`
                : "Expired"}
            </span>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Certificate</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <Row label="Issuer" value={latest?.issuer ?? "—"} />
            <Row label="Issuer Org" value={latest?.issuerOrg ?? "—"} />
            <Row label="Serial" value={latest?.serial ?? "—"} mono />
            <Row label="Valid From" value={formatDate(latest?.notBefore)} />
            <Row label="Valid To" value={formatDate(latest?.notAfter)} />
            <Row
              label="Last Check"
              value={
                latest?.checkedAt
                  ? `${formatDate(latest.checkedAt)} (${formatDistanceToNowStrict(
                      new Date(latest.checkedAt)
                    )})`
                  : "—"
              }
            />
            {latest?.error && (
              <p className="mt-2 rounded-md bg-rose-50 p-2 text-xs text-rose-700">
                {latest.error}
              </p>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Check History (last 10)</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            {checks.length === 0 ? (
              <p className="p-6 text-sm text-slate-500">No checks yet.</p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>When</TableHead>
                    <TableHead className="text-right">Days</TableHead>
                    <TableHead>Status</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {checks.map((c) => (
                    <TableRow key={c.id}>
                      <TableCell>
                        {formatDistanceToNowStrict(new Date(c.checkedAt))}
                      </TableCell>
                      <TableCell className="text-right font-mono">
                        {c.daysRemaining ?? "—"}
                      </TableCell>
                      <TableCell>
                        {c.error ? (
                          <span className="text-rose-600">Error</span>
                        ) : (
                          <StatusBadge daysRemaining={c.daysRemaining} />
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function Row({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-start justify-between gap-4 border-b border-slate-100 py-1.5 last:border-0">
      <span className="text-slate-500">{label}</span>
      <span
        className={`max-w-[60%] text-right text-slate-900 ${mono ? "font-mono text-xs" : ""}`}
        title={value}
      >
        {value}
      </span>
    </div>
  );
}
