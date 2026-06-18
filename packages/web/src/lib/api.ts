const API_BASE = (import.meta.env.VITE_API_URL as string | undefined) ?? "";

/**
 * API token (bearer). Stored in localStorage so the value survives a
 * page reload. Empty string = no token, in which case the dashboard
 * depends on `AUTH_DISABLED=1` on the server (dev mode only — the
 * production deploy must set this token). (v0.4.1 code-review
 * CRITICAL — previously the dashboard never sent Authorization and
 * silently 401'd in production.)
 */
const TOKEN_STORAGE_KEY = "certpulse.token";

function readToken(): string {
  try {
    return localStorage.getItem(TOKEN_STORAGE_KEY) ?? "";
  } catch {
    return "";
  }
}

function writeToken(token: string): void {
  try {
    if (token) localStorage.setItem(TOKEN_STORAGE_KEY, token);
    else localStorage.removeItem(TOKEN_STORAGE_KEY);
  } catch {
    /* localStorage unavailable — token stays empty for this session */
  }
}

export function setApiToken(token: string): void {
  writeToken(token);
}

export function clearApiToken(): void {
  writeToken("");
}

export function getApiToken(): string {
  return readToken();
}

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

/**
 * API request helper. Attaches the bearer token from localStorage
 * (if any) and parses JSON. Throws an `ApiError` (with the HTTP
 * status) on a non-2xx response. (v0.4.1 code-review HIGH — the
 * previous version discarded the status code.)
 */
export class ApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const token = readToken();
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(init?.headers as Record<string, string> | undefined),
  };
  if (token) headers["Authorization"] = `Bearer ${token}`;
  const res = await fetch(`${API_BASE}${path}`, { ...init, headers });
  if (!res.ok) {
    const status = res.status;
    let message: string;
    // Sanitize non-JSON error bodies — a 502 from nginx returns HTML
    // and dumping that into Error.message makes the UI unusable.
    const ct = res.headers.get("content-type") ?? "";
    if (ct.includes("application/json")) {
      try {
        const body = (await res.json()) as { error?: unknown };
        message =
          typeof body?.error === "string" ? body.error : `Request failed: ${status}`;
      } catch {
        message = `Request failed: ${status}`;
      }
    } else {
      message = status === 401
        ? "Unauthorized — check your API token"
        : `Request failed: ${status}`;
    }
    throw new ApiError(status, message);
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
