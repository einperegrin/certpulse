import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "../components/ui/card";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { ChevronLeft, ChevronRight, RefreshCw } from "lucide-react";

const PAGE_SIZE = 50;

function fmtTime(iso: string): string {
  // SQLite `datetime('now')` produces "YYYY-MM-DD HH:MM:SS" in UTC. The
  // API may also return a full ISO string from the in-memory test
  // harness, so we handle both. We don't reformat the date — the user
  // already knows their timezone.
  return iso.replace("T", " ").replace(/\.\d{3}Z$/, " UTC").replace("Z", " UTC");
}

function actionBadgeClass(action: string): string {
  if (action.startsWith("domain.delete") || action.startsWith("token.revoke"))
    return "bg-rose-50 text-rose-700 ring-rose-200";
  if (action.startsWith("domain.create") || action.startsWith("channel.create"))
    return "bg-emerald-50 text-emerald-700 ring-emerald-200";
  if (action.startsWith("auth.login.failure"))
    return "bg-amber-50 text-amber-700 ring-amber-200";
  return "bg-slate-50 text-slate-700 ring-slate-200";
}

export function AuditLog() {
  const [action, setAction] = React.useState("");
  const [actorType, setActorType] = React.useState("");
  const [resourceType, setResourceType] = React.useState("");
  const [since, setSince] = React.useState("");
  const [until, setUntil] = React.useState("");
  const [offset, setOffset] = React.useState(0);

  // Reset pagination when filters change.
  React.useEffect(() => {
    setOffset(0);
  }, [action, actorType, resourceType, since, until]);

  const query = useQuery({
    queryKey: ["audit-log", action, actorType, resourceType, since, until, offset],
    queryFn: () =>
      api.listAuditLog({
        action: action || undefined,
        actorType:
          actorType === ""
            ? undefined
            : (actorType as "user" | "api_token" | "system"),
        resourceType: resourceType || undefined,
        // The backend accepts ISO-8601 datetimes for `since` / `until`.
        // The HTML date input gives us a YYYY-MM-DD string, which is a
        // valid ISO-8601 *date* (interpreted as UTC midnight by the
        // server). That's good enough for a v0.3 filter UI; a
        // date+time picker is a v0.4 enhancement.
        since: since ? `${since}T00:00:00Z` : undefined,
        until: until ? `${until}T23:59:59Z` : undefined,
        limit: PAGE_SIZE,
        offset,
      }),
    refetchInterval: 15_000,
  });

  const rows = query.data?.rows ?? [];
  const total = query.data?.total ?? 0;
  const page = Math.floor(offset / PAGE_SIZE) + 1;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-slate-900">
            Audit log
          </h1>
          <p className="text-sm text-slate-500">
            Who did what, and when. Newest first.
          </p>
        </div>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => query.refetch()}
          disabled={query.isFetching}
        >
          <RefreshCw className="mr-1 h-4 w-4" />
          Refresh
        </Button>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Filters</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 gap-3 md:grid-cols-3 lg:grid-cols-5">
            <div>
              <label
                htmlFor="audit-filter-action"
                className="mb-1 block text-xs font-medium uppercase tracking-wide text-slate-500"
              >
                Action
              </label>
              <Input
                id="audit-filter-action"
                placeholder="domain.% or channel.create"
                value={action}
                onChange={(e) => setAction(e.target.value)}
              />
            </div>
            <div>
              <label
                htmlFor="audit-filter-actor"
                className="mb-1 block text-xs font-medium uppercase tracking-wide text-slate-500"
              >
                Actor
              </label>
              <select
                id="audit-filter-actor"
                className="block w-full rounded-md border border-slate-200 bg-white px-2 py-1 text-sm text-slate-900"
                value={actorType}
                onChange={(e) => setActorType(e.target.value)}
              >
                <option value="">All</option>
                <option value="user">user</option>
                <option value="api_token">api_token</option>
                <option value="system">system</option>
              </select>
            </div>
            <div>
              <label
                htmlFor="audit-filter-resource"
                className="mb-1 block text-xs font-medium uppercase tracking-wide text-slate-500"
              >
                Resource
              </label>
              <Input
                id="audit-filter-resource"
                placeholder="domain | channel | token"
                value={resourceType}
                onChange={(e) => setResourceType(e.target.value)}
              />
            </div>
            <div>
              <label
                htmlFor="audit-filter-since"
                className="mb-1 block text-xs font-medium uppercase tracking-wide text-slate-500"
              >
                Since
              </label>
              <Input
                id="audit-filter-since"
                type="date"
                value={since}
                onChange={(e) => setSince(e.target.value)}
              />
            </div>
            <div>
              <label
                htmlFor="audit-filter-until"
                className="mb-1 block text-xs font-medium uppercase tracking-wide text-slate-500"
              >
                Until
              </label>
              <Input
                id="audit-filter-until"
                type="date"
                value={until}
                onChange={(e) => setUntil(e.target.value)}
              />
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="p-0">
          {query.isLoading ? (
            <div className="p-6 text-sm text-slate-500">Loading…</div>
          ) : query.isError ? (
            <div className="p-6 text-sm text-rose-700">
              Failed to load: {String(query.error)}
            </div>
          ) : rows.length === 0 ? (
            <div className="p-6 text-sm text-slate-500">
              No audit entries match the current filters.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="border-b border-slate-200 bg-slate-50 text-left text-xs font-medium uppercase tracking-wide text-slate-500">
                  <tr>
                    <th className="px-4 py-2">When</th>
                    <th className="px-4 py-2">Actor</th>
                    <th className="px-4 py-2">Action</th>
                    <th className="px-4 py-2">Resource</th>
                    <th className="px-4 py-2">Metadata</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr
                      key={r.id}
                      className="border-b border-slate-100 last:border-0 hover:bg-slate-50"
                    >
                      <td className="whitespace-nowrap px-4 py-2 font-mono text-xs text-slate-600">
                        {fmtTime(r.timestamp)}
                      </td>
                      <td className="whitespace-nowrap px-4 py-2 text-slate-700">
                        {r.actorType}
                        {r.actorId ? (
                          <span className="ml-1 text-slate-400">
                            ({r.actorId})
                          </span>
                        ) : null}
                      </td>
                      <td className="px-4 py-2">
                        <span
                          className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ring-1 ${actionBadgeClass(
                            r.action
                          )}`}
                        >
                          {r.action}
                        </span>
                      </td>
                      <td className="px-4 py-2 text-slate-700">
                        {r.resourceType}
                        {r.resourceId ? (
                          <span className="ml-1 text-slate-400">
                            ({r.resourceId})
                          </span>
                        ) : null}
                      </td>
                      <td className="max-w-xs truncate px-4 py-2 font-mono text-xs text-slate-500">
                        {r.metadata ? JSON.stringify(r.metadata) : "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      <div className="flex items-center justify-between text-sm text-slate-600">
        <span>
          {total === 0
            ? "No entries"
            : `Showing ${offset + 1}–${Math.min(
                offset + PAGE_SIZE,
                total
              )} of ${total}`}
        </span>
        <div className="flex items-center gap-2">
          <Button
            variant="ghost"
            size="sm"
            disabled={offset === 0}
            onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
          >
            <ChevronLeft className="mr-1 h-4 w-4" />
            Prev
          </Button>
          <span className="text-xs text-slate-500">
            Page {page} / {totalPages}
          </span>
          <Button
            variant="ghost"
            size="sm"
            disabled={offset + PAGE_SIZE >= total}
            onClick={() => setOffset(offset + PAGE_SIZE)}
          >
            Next
            <ChevronRight className="ml-1 h-4 w-4" />
          </Button>
        </div>
      </div>
    </div>
  );
}
