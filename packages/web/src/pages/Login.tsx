import * as React from "react";
import { useNavigate } from "react-router-dom";
import { ShieldCheck, Loader2 } from "lucide-react";
import { Button } from "../components/ui/button";
import { Input, Label } from "../components/ui/input";
import {
  setApiToken,
  getApiToken,
  api,
  ApiError,
} from "../lib/api";

/**
 * Login page — captures the API bearer token from the operator and
 * stores it in localStorage. Used by the production build, where the
 * dashboard must present a Bearer token instead of relying on the dev
 * escape hatch `AUTH_DISABLED=1`.
 *
 * The token is verified against `/api/domains` (a cheap auth-protected
 * endpoint) before the form considers login successful — this gives a
 * clean "invalid token" path without needing a dedicated /api/login
 * route. (v0.5 — Bug 2 fix: the dashboard had no way to authenticate
 * before.)
 *
 * If a token is already present in localStorage, the page redirects to
 * `/` immediately so a refresh does not bounce the user back to the
 * login form. The escape button only shows when there IS a stored
 * token (otherwise the form is the only way in).
 */
export function Login() {
  const navigate = useNavigate();
  const [token, setToken] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const [submitting, setSubmitting] = React.useState(false);

  // If we already have a token, do not block on the login page — bounce
  // to the dashboard so a refresh after first login is seamless.
  React.useEffect(() => {
    if (getApiToken()) navigate("/", { replace: true });
  }, [navigate]);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = token.trim();
    if (!trimmed) {
      setError("Token is required.");
      return;
    }
    setSubmitting(true);
    setError(null);
    // Save the token BEFORE the probe so the api.ts request() reads it.
    setApiToken(trimmed);
    try {
      await api.listDomains();
      navigate("/", { replace: true });
    } catch (err) {
      // Token was bad — clear it so the next attempt is honest.
      setApiToken("");
      if (err instanceof ApiError && err.status === 401) {
        setError("Invalid token. Please check the value and try again.");
      } else {
        setError(
          err instanceof Error ? err.message : "Could not reach the API."
        );
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="mx-auto flex min-h-[60vh] max-w-md flex-col items-center justify-center px-4">
      <div className="w-full rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
        <div className="mb-4 flex items-center gap-2">
          <ShieldCheck className="h-6 w-6 text-sky-600" />
          <h1 className="text-lg font-semibold text-slate-900">
            CertPulse login
          </h1>
        </div>
        <p className="mb-4 text-sm text-slate-600">
          Paste your API token. It is stored in localStorage and sent as a
          <code className="mx-1 rounded bg-slate-100 px-1 py-0.5 text-xs">
            Bearer
          </code>
          header on every request. Create one with{" "}
          <code className="rounded bg-slate-100 px-1 py-0.5 text-xs">
            certpulse token create --label &lt;name&gt;
          </code>
          .
        </p>
        <form onSubmit={onSubmit} className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="api-token">API token</Label>
            <Input
              id="api-token"
              name="api-token"
              type="password"
              autoFocus
              autoComplete="off"
              spellCheck={false}
              placeholder="cp_live_..."
              value={token}
              onChange={(e) => setToken(e.target.value)}
              disabled={submitting}
              required
            />
          </div>
          {error && (
            <p
              role="alert"
              data-testid="login-error"
              className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800"
            >
              {error}
            </p>
          )}
          <Button
            type="submit"
            className="w-full"
            disabled={submitting || !token.trim()}
          >
            {submitting ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" />
                Verifying…
              </>
            ) : (
              "Sign in"
            )}
          </Button>
        </form>
        {getApiToken() && (
          <div className="mt-4 border-t border-slate-200 pt-3 text-xs text-slate-500">
            A token is already saved in this browser. Use the form above to
            replace it.
          </div>
        )}
      </div>
    </div>
  );
}