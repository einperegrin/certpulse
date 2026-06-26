import * as React from "react";
import { useNavigate, useLocation } from "react-router-dom";
import { ShieldCheck, AlertCircle } from "lucide-react";
import { Button } from "../components/ui/button";
import { Input, Label } from "../components/ui/input";
import { Card, CardHeader, CardTitle, CardContent } from "../components/ui/card";
import { setApiToken, api, ApiError } from "../lib/api";

// Login page. Accepts an API token, writes it to localStorage, probes
// /api/domains to confirm the token is valid, then redirects. Token
// storage: localStorage (not a cookie); nginx forwards Authorization.
export default function Login() {
  const navigate = useNavigate();
  const location = useLocation();
  const [token, setToken] = React.useState("");
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const from = (location.state as { from?: string } | null)?.from ?? "/";

  React.useEffect(() => {
    document.title = "Sign in · SSLert";
  }, []);

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const trimmed = token.trim();
    if (!trimmed) {
      setError("Please paste an API token.");
      return;
    }
    setSubmitting(true);
    setError(null);
    setApiToken(trimmed);
    try {
      // 200 → token is valid; 401 → token wrong; network/502 → api is down.
      await api.listDomains();
      navigate(from, { replace: true });
    } catch (err) {
      // Clear the token so the user can retry without seeing a stale header.
      setApiToken("");
      if (err instanceof ApiError && err.status === 401) {
        setError("That token was rejected (401). Check `sslert token list`.");
      } else if (err instanceof Error) {
        setError(err.message);
      } else {
        setError("Unknown error");
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-50 px-4">
      <Card className="w-full max-w-md">
        <CardHeader>
          <div className="flex items-center gap-2">
            <ShieldCheck className="h-6 w-6 text-sky-600" />
            <CardTitle className="text-lg">Sign in to SSLert</CardTitle>
          </div>
          <p className="text-sm text-slate-500">
            Paste an API token created with{" "}
            <code className="rounded bg-slate-100 px-1">sslert token create</code>.
          </p>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-4" data-testid="login-form">
            <div className="space-y-1.5">
              <Label htmlFor="token">API token</Label>
              <Input
                id="token"
                name="token"
                type="password"
                autoComplete="off"
                autoFocus
                placeholder="cp_…"
                value={token}
                onChange={(e) => setToken(e.target.value)}
                disabled={submitting}
                data-testid="login-token-input"
              />
            </div>
            {error && (
              <div
                role="alert"
                data-testid="login-error"
                className="flex items-start gap-2 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800"
              >
                <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                <span>{error}</span>
              </div>
            )}
            <Button
              type="submit"
              className="w-full"
              disabled={submitting || !token.trim()}
              data-testid="login-submit"
            >
              {submitting ? "Verifying…" : "Sign in"}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
