/**
 * E2E test for expired / revoked certificate handling (bug #6).
 *
 * Bug: with `rejectUnauthorized: true`, Node's TLS layer aborts the
 * handshake on expired certs BEFORE `getPeerCertificate()` fires, so
 * all cert metadata (notAfter, issuer, daysRemaining) is lost and the
 * dashboard shows a generic "Error" instead of "Expired" with the
 * actual expiry date.
 *
 * Fix: `rejectUnauthorized: false` + manual expiry check in checker.ts.
 * The cert metadata is always extracted, then `valid` is computed
 * from `notAfter < now`.
 *
 * Test domains from https://www.ssl.com/sample-test-domains/:
 *   Expired:  expired-rsa-dv.ssl.com (cert expired Aug 2019)
 *   Revoked:  revoked-rsa-dv.ssl.com  (cert valid but CA-revoked)
 *
 * Note on revoked certs: without OCSP/CRL checking, the TLS layer
 * cannot distinguish a revoked cert from a valid one — both pass
 * the handshake. This test asserts that the checker returns the cert
 * metadata (daysRemaining > 0, no error) for revoked domains, which
 * is the known limitation documented in checker.ssl-com.test.ts.
 * The UI should show "Healthy" for revoked — this is correct given
 * the absence of OCSP checking. A future enhancement can add OCSP
 * fetching to correctly flag revoked certs.
 */
import { test, expect } from "@playwright/test";
import {
  apiBase,
  authToken,
  cleanupDomainByHostname,
  loginAs,
  expectDashboard,
} from "./helpers";

test.describe("Cert status: expired and revoked domains (bug #6)", () => {
  test.beforeEach(async ({ page }) => {
    await loginAs(page);
    await expectDashboard(page);
  });

  test("expired cert shows 'Expired' badge + 'Certificate expired' error in the table", async ({
    page,
    request,
  }) => {
    const hostname = "expired-rsa-dv.ssl.com";

    // Seed the domain via API.
    const createRes = await request.post(`${apiBase()}/api/domains`, {
      headers: { Authorization: `Bearer ${authToken()}` },
      data: { hostname, port: 443 },
    });
    expect(createRes.ok()).toBe(true);

    // Wait for a check to complete and verify the API returns
    // valid=false + error=cert_expired + populated cert metadata.
    const start = Date.now();
    let apiResult: {
      valid: boolean;
      error: string | null;
      daysRemaining: number | null;
      notAfter: string | null;
    } | null = null;
    while (Date.now() - start < 20_000) {
      const res = await request.get(`${apiBase()}/api/domains`, {
        headers: { Authorization: `Bearer ${authToken()}` },
      });
      const body = (await res.json()) as {
        domains: {
          domain: { hostname: string };
          lastCheck: {
            valid: boolean;
            error: string | null;
            daysRemaining: number | null;
            notAfter: string | null;
          } | null;
        }[];
      };
      const match = body.domains.find((d) => d.domain.hostname === hostname);
      if (match?.lastCheck) {
        apiResult = match.lastCheck;
        break;
      }
      await new Promise((r) => setTimeout(r, 300));
    }
    expect(apiResult).not.toBeNull();
    expect(apiResult!.valid).toBe(false);
    expect(apiResult!.error).toBe("cert_expired");
    expect(apiResult!.daysRemaining).not.toBeNull();
    expect(apiResult!.daysRemaining!).toBeLessThanOrEqual(0);
    expect(apiResult!.notAfter).toBeTruthy();

    // Reload dashboard and verify the UI renders correctly.
    await page.goto(apiBase().replace(/\/api$/, "") + "/");
    await expectDashboard(page);

    const row = page.locator("table tbody tr", {
      hasText: hostname,
    }).first();
    await expect(row).toBeVisible({ timeout: 15_000 });

    // The Status column (index 5) should contain "Expired" badge.
    const statusCell = row.locator("td").nth(5);
    await expect(statusCell.getByText(/expired/i)).toBeVisible();

    // And the human-readable error label "Certificate expired".
    await expect(statusCell.getByText(/certificate expired/i)).toBeVisible();

    await cleanupDomainByHostname(request, hostname);
  });

  test("revoked cert (no OCSP) shows as healthy — known limitation", async ({
    page,
    request,
  }) => {
    const hostname = "revoked-rsa-dv.ssl.com";

    const createRes = await request.post(`${apiBase()}/api/domains`, {
      headers: { Authorization: `Bearer ${authToken()}` },
      data: { hostname, port: 443 },
    });
    expect(createRes.ok()).toBe(true);

    // Wait for check to complete.
    const start = Date.now();
    let apiResult: {
      valid: boolean;
      error: string | null;
      daysRemaining: number | null;
    } | null = null;
    while (Date.now() - start < 20_000) {
      const res = await request.get(`${apiBase()}/api/domains`, {
        headers: { Authorization: `Bearer ${authToken()}` },
      });
      const body = (await res.json()) as {
        domains: {
          domain: { hostname: string };
          lastCheck: {
            valid: boolean;
            error: string | null;
            daysRemaining: number | null;
          } | null;
        }[];
      };
      const match = body.domains.find((d) => d.domain.hostname === hostname);
      if (match?.lastCheck) {
        apiResult = match.lastCheck;
        break;
      }
      await new Promise((r) => setTimeout(r, 300));
    }
    expect(apiResult).not.toBeNull();

    // Without OCSP, the TLS handshake succeeds and the cert is not
    // expired, so the checker reports valid=true. This is the
    // documented limitation: we cannot detect revocation without
    // OCSP/CRL checking.
    expect(apiResult!.valid).toBe(true);
    expect(apiResult!.daysRemaining).not.toBeNull();
    expect(apiResult!.daysRemaining!).toBeGreaterThan(0);

    // Clean up.
    await cleanupDomainByHostname(request, hostname);
  });
});