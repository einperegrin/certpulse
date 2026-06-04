import { describe, expect, it } from "vitest";
import { extractWhoisExpiry } from "./whois.js";

describe("extractWhoisExpiry", () => {
  it("parses registry expiry date", () => {
    const text = `
Domain Name: EXAMPLE.COM
   Registry Domain ID: 12345
   Registrar WHOIS Server: whois.iana.org
   Registrar URL: http://www.iana.org
   Updated Date: 2024-01-01T00:00:00Z
   Creation Date: 2010-01-01T00:00:00Z
   Registry Expiry Date: 2027-08-13T04:00:00Z
   Registrar: IANA
`;
    const r = extractWhoisExpiry(text);
    expect(r.expiresAt).toBe("2027-08-13T04:00:00.000Z");
  });

  it("parses registrar registration expiration date", () => {
    const text = `
Domain Name: example.com
   Registrar Registration Expiration Date: 2026-12-31T23:59:59Z
   Registrar: SomeRegistrar
`;
    const r = extractWhoisExpiry(text);
    expect(r.expiresAt).toBe("2026-12-31T23:59:59.000Z");
  });

  it("parses expires-on style fields", () => {
    const text = `
Domain: example.com
   expires on: 2025-06-01T00:00:00.0Z
`;
    const r = extractWhoisExpiry(text);
    expect(r.expiresAt).toBe("2025-06-01T00:00:00.000Z");
  });

  it("returns null when no expiry field is present", () => {
    const r = extractWhoisExpiry("Domain: example.com\nRegistrar: Foo");
    expect(r.expiresAt).toBeNull();
  });

  it("returns null for unparseable dates", () => {
    const r = extractWhoisExpiry("Domain: example.com\nRegistry Expiry Date: not-a-date");
    expect(r.expiresAt).toBeNull();
  });

  it("extracts registrar", () => {
    const text = "Domain: example.com\nRegistrar: MarkMonitor Inc.\n";
    const r = extractWhoisExpiry(text);
    expect(r.registrar).toBe("MarkMonitor Inc.");
  });
});
