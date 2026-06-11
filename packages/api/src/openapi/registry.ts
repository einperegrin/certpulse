/**
 * OpenAPI registry + shared security scheme.
 *
 * Routes register their `describeRoute(...)` config against the shared
 * `openApiRegistry`; `index.ts` mounts `/api/openapi.json` and
 * `/api/docs` before auth middleware, so a caller does NOT need a
 * Bearer token to inspect the spec.
 */
import {
  extendZodWithOpenApi,
} from "@hono/zod-openapi";
import {
  OpenAPIRegistry,
  OpenApiGeneratorV31,
} from "@asteasolutions/zod-to-openapi";
import { z } from "zod";

// Lets us tag Zod schemas with metadata (`.openapi(...)`).
extendZodWithOpenApi(z);

export const openApiRegistry = new OpenAPIRegistry();

// Security scheme: Bearer token. Documented in `components.securitySchemes`.
// Routes that require it list `security: [{ bearerAuth: [] }]`.
openApiRegistry.registerComponent("securitySchemes", "bearerAuth", {
  type: "http",
  scheme: "bearer",
  description:
    "API token issued by `npm run token:create` (or " +
    "`tsx src/cli/tokens.ts create`). Pass as " +
    "`Authorization: Bearer ***`. Set AUTH_DISABLED=1 to disable auth " +
    "in dev (NOT for production).",
});

/**
 * Build the OpenAPI 3.1 document for the CertPulse HTTP API.
 * Pulls everything registered against `openApiRegistry` and adds the
 * `info` and `servers` blocks.
 */
export function buildOpenApiDocument(baseUrl: string) {
  const generator = new OpenApiGeneratorV31(openApiRegistry.definitions);
  return generator.generateDocument({
    openapi: "3.1.0",
    info: {
      title: "CertPulse API",
      version: "0.4.0",
      description:
        "Self-hosted SSL/TLS certificate and domain expiry monitor. " +
        "All `/api/*` routes EXCEPT `/api/openapi.json`, `/api/docs`, " +
        "`/health/*`, and `/metrics` require a Bearer token (see " +
        "`securitySchemes.bearerAuth`).",
    },
    servers: [{ url: baseUrl, description: "This instance" }],
  });
}

// Re-export `z` so route files only need one import.
export { z };
