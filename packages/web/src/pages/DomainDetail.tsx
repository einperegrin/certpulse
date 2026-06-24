import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useParams, Link } from "react-router-dom";
import {
  ArrowLeft,
  RefreshCw,
  Trash2,
  Loader2,
  ShieldCheck,
  Globe,
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
import { ChannelsEditor } from "../components/ChannelsEditor";
import { api } from "../lib/api";
import { formatDate, formatDistanceToNowStrict } from "../lib/format";
import { certErrorTitle, certErrorDescription } from "../lib/cert-errors";

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
  const domainDays = latest?.domainExpiresDaysRemaining ?? null;

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
          <div className="mt-1 flex items-center gap-3 text-sm text-slate-500">
            <span className="flex items-center gap-1">
              <StatusBadge daysRemaining={days} />
              <span>
                {days === null || days === undefined
                  ? "Cert never checked"
                  : days > 0
                  ? `${days} days remaining`
                  : "Cert expired"}
              </span>
            </span>
            {domainDays !== null && domainDays !== undefined && (
              <span className="flex items-center gap-1">
                <Globe className="h-3 w-3 text-slate-400" />
                {domainDays > 0
                  ? `Domain expires in ${domainDays} days`
                  : "Domain expired"}
              </span>
            )}
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <ShieldCheck className="h-4 w-4" /> TLS Certificate
            </CardTitle>
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
              // Bug #2 fix (2026-06-23): show the human-readable
              // title and description for the error code the
              // checker wrote, instead of the raw `cert_expired`
              // / `cert_revoked` / `dns_not_found` token. Operators
              // get actionable context in the same box.
              <div
                role="alert"
                className="mt-2 rounded-md bg-rose-50 p-2 text-xs text-rose-700"
              >
                <p className="font-medium">
                  {certErrorTitle(latest.error)}
                </p>
                <p className="mt-0.5 text-rose-600">
                  {certErrorDescription(latest.error)}
                </p>
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Globe className="h-4 w-4" /> Domain Registration
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <Row label="Registrar" value={latest?.domainRegistrar ?? "—"} />
            <Row
              label="Expires"
              value={
                latest?.domainExpiresAt
                  ? `${formatDate(latest.domainExpiresAt)} (${formatDistanceToNowStrict(
                      new Date(latest.domainExpiresAt)
                    )})`
                  : "—"
              }
            />
            <Row
              label="Days Remaining"
              value={
                domainDays === null || domainDays === undefined
                  ? "—"
                  : String(domainDays)
              }
            />
            {latest?.domainRegistrarError && (
              <p className="mt-2 rounded-md bg-rose-50 p-2 text-xs text-rose-700">
                {latest.domainRegistrarError}
              </p>
            )}
            {!latest?.domainRegistrarError &&
              (latest?.domainExpiresAt === null || latest?.domainExpiresAt === undefined) && (
                <p className="mt-2 rounded-md bg-slate-50 p-2 text-xs text-slate-600">
                  WHOIS/RDAP not yet resolved — re-run "Check Now" to retry.
                </p>
              )}
          </CardContent>
        </Card>
      </div>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
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
                    <TableHead className="text-right">Cert Days</TableHead>
                    <TableHead className="text-right">Domain Days</TableHead>
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
                      <TableCell className="text-right font-mono">
                        {c.domainExpiresDaysRemaining ?? "—"}
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

        <ChannelsEditor domainId={domainId} />
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
