import { useNavigate } from "react-router-dom";
import { RefreshCw, Trash2, Loader2 } from "lucide-react";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "./ui/table";
import { Button } from "./ui/button";
import { StatusBadge } from "./StatusBadge";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api, type DomainRow } from "../lib/api";
import { formatDistanceToNowStrict } from "../lib/format";

export function DomainTable({ rows }: { rows: DomainRow[] }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const checkMutation = useMutation({
    mutationFn: (id: number) => api.checkNow(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["domains"] });
      queryClient.invalidateQueries({ queryKey: ["dashboard"] });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (id: number) => api.deleteDomain(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["domains"] });
      queryClient.invalidateQueries({ queryKey: ["dashboard"] });
    },
  });

  if (rows.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-slate-300 p-12 text-center text-sm text-slate-500">
        No domains yet. Click <span className="font-medium">+ Add</span> to start monitoring.
      </div>
    );
  }

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Domain</TableHead>
          <TableHead>Issuer</TableHead>
          <TableHead className="text-right">Days Left</TableHead>
          <TableHead>Last Check</TableHead>
          <TableHead>Status</TableHead>
          <TableHead className="text-right">Actions</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map(({ domain, lastCheck }) => {
          const days = lastCheck?.daysRemaining ?? null;
          return (
            <TableRow
              key={domain.id}
              className="cursor-pointer"
              onClick={() => navigate(`/domains/${domain.id}`)}
            >
              <TableCell className="font-mono text-slate-900">
                {domain.hostname}
                <span className="ml-1 text-slate-400">:{domain.port}</span>
              </TableCell>
              <TableCell>
                {lastCheck?.issuerOrg ?? lastCheck?.issuer ?? "—"}
              </TableCell>
              <TableCell className="text-right font-mono">
                {days === null || days === undefined ? "—" : days}
              </TableCell>
              <TableCell>
                {lastCheck?.checkedAt
                  ? formatDistanceToNowStrict(new Date(lastCheck.checkedAt))
                  : "—"}
              </TableCell>
              <TableCell>
                <StatusBadge daysRemaining={days} />
              </TableCell>
              <TableCell className="text-right">
                <div
                  className="flex justify-end gap-1"
                  onClick={(e) => e.stopPropagation()}
                >
                  <Button
                    size="icon"
                    variant="ghost"
                    title="Check now"
                    disabled={checkMutation.isPending}
                    onClick={() => checkMutation.mutate(domain.id)}
                  >
                    {checkMutation.isPending &&
                    checkMutation.variables === domain.id ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <RefreshCw className="h-4 w-4" />
                    )}
                  </Button>
                  <Button
                    size="icon"
                    variant="ghost"
                    title="Delete"
                    onClick={() => {
                      if (confirm(`Remove ${domain.hostname}?`)) {
                        deleteMutation.mutate(domain.id);
                      }
                    }}
                  >
                    <Trash2 className="h-4 w-4 text-rose-500" />
                  </Button>
                </div>
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}
