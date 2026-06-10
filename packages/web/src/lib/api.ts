const API_BASE = (import.meta.env.VITE_API_URL as string | undefined) ?? "";

export interface Domain {
  id: number;
  hostname: string;
  port: number;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface Check {
  id: number;
  domainId: number;
  checkedAt: string;
  valid: boolean;
  issuer: string | null;
  issuerOrg: string | null;
  serial: string | null;
  notBefore: string | null;
  notAfter: string | null;
  daysRemaining: number | null;
  error: string | null;
  rawPem: string | null;
  domainExpiresAt: string | null;
  domainExpiresDaysRemaining: number | null;
  domainRegistrar: string | null;
  domainRegistrarError: string | null;
}

export interface DomainRow {
  domain: Domain;
  lastCheck?: {
    id: number;
    valid: boolean;
    daysRemaining: number | null;
    notAfter: string | null;
    issuer: string | null;
    issuerOrg: string | null;
    error: string | null;
    checkedAt: string;
    domainExpiresAt: string | null;
    domainExpiresDaysRemaining: number | null;
    domainRegistrar: string | null;
    domainRegistrarError: string | null;
  } | null;
}

export interface AlertChannel {
  id: number;
  domainId: number;
  channel: "email" | "webhook" | "telegram" | "slack" | "ntfy";
  enabled: boolean;
  config: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface DashboardSummary {
  total: number;
  expiringSoon: number;
  expired: number;
  healthy: number;
  unchecked: number;
  domainExpiringSoon: number;
  domainExpired: number;
  domains: DomainRow[];
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
    ...init,
  });
  if (!res.ok) {
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      body = await res.text();
    }
    const message =
      typeof body === "object" && body && "error" in body
        ? String((body as { error: unknown }).error)
        : `Request failed: ${res.status}`;
    throw new Error(message);
  }
  return (await res.json()) as T;
}

export const api = {
  listDomains: () => request<{ domains: DomainRow[] }>("/api/domains"),
  getDomain: (id: number) =>
    request<{ domain: Domain; checks: Check[] }>(`/api/domains/${id}`),
  addDomain: (hostname: string, port = 443) =>
    request<{ domain: Domain; firstCheck: unknown }>("/api/domains", {
      method: "POST",
      body: JSON.stringify({ hostname, port }),
    }),
  deleteDomain: (id: number) =>
    request<{ ok: boolean }>(`/api/domains/${id}`, { method: "DELETE" }),
  checkNow: (id: number) =>
    request<{ ok: boolean; outcome: unknown }>(`/api/domains/${id}/check`, {
      method: "POST",
    }),
  dashboard: () => request<DashboardSummary>("/api/dashboard"),
  recentChecks: (domainId?: number) => {
    const q = domainId ? `?domain_id=${domainId}` : "";
    return request<{ checks: Check[] }>(`/api/checks${q}`);
  },
  listChannels: (domainId: number) =>
    request<{ channels: AlertChannel[] }>(`/api/domains/${domainId}/channels`),
  upsertChannel: (
    domainId: number,
    channel: AlertChannel["channel"],
    body: { enabled?: boolean; config?: Record<string, unknown> }
  ) =>
    request<{ channel: AlertChannel }>(`/api/domains/${domainId}/channels`, {
      method: "POST",
      body: JSON.stringify({ channel, ...body }),
    }),
  deleteChannel: (domainId: number, id: number) =>
    request<{ ok: boolean }>(`/api/domains/${domainId}/channels/${id}`, {
      method: "DELETE",
    }),
  config: () =>
    request<{
      checkIntervalMinutes: number;
      hasResend: boolean;
      alertEmailTo: string | null;
    }>("/api/config"),
  health: () => request<{ ok: boolean; ts: string }>("/health"),
  listAuditLog: (params?: {
    actorType?: "user" | "api_token" | "system";
    action?: string;
    resourceType?: string;
    since?: string;
    until?: string;
    limit?: number;
    offset?: number;
  }) => {
    const q = new URLSearchParams();
    if (params?.actorType) q.set("actor_type", params.actorType);
    if (params?.action) q.set("action", params.action);
    if (params?.resourceType) q.set("resource_type", params.resourceType);
    if (params?.since) q.set("since", params.since);
    if (params?.until) q.set("until", params.until);
    if (params?.limit) q.set("limit", String(params.limit));
    if (params?.offset) q.set("offset", String(params.offset));
    const qs = q.toString();
    return request<{
      rows: Array<{
        id: number;
        timestamp: string;
        actorType: string;
        actorId: string | null;
        action: string;
        resourceType: string;
        resourceId: string | null;
        metadata: Record<string, unknown> | null;
      }>;
      total: number;
      limit: number;
      offset: number;
    }>(`/api/audit-log${qs ? `?${qs}` : ""}`);
  },
};
