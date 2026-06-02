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
  } | null;
}

export interface DashboardSummary {
  total: number;
  expiringSoon: number;
  expired: number;
  healthy: number;
  unchecked: number;
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
  config: () =>
    request<{
      checkIntervalMinutes: number;
      hasResend: boolean;
      alertEmailTo: string | null;
    }>("/api/config"),
  health: () => request<{ ok: boolean; ts: string }>("/health"),
};
