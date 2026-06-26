import * as React from "react";
import { Routes, Route, Link, useLocation, Navigate } from "react-router-dom";
import { ShieldCheck, LogOut } from "lucide-react";
import { Button } from "./components/ui/button";
import { AddDomainDialog } from "./components/AddDomainDialog";
import { Dashboard } from "./pages/Dashboard";
import { DomainDetail } from "./pages/DomainDetail";
import { AuditLog } from "./pages/AuditLog";
import Login from "./pages/Login";
import { RequireAuth } from "./components/RequireAuth";
import { clearApiToken, getApiToken } from "./lib/api";

export default function App() {
  const [addOpen, setAddOpen] = React.useState(false);
  const location = useLocation();
  const [hasToken, setHasToken] = React.useState<boolean>(() => Boolean(getApiToken()));
  React.useEffect(() => {
    const onTokenChange = () => setHasToken(Boolean(getApiToken()));
    // Listen for both cross-tab (`storage`) and same-tab (custom event
    // dispatched by setApiToken/clearApiToken) token changes.
    window.addEventListener("storage", onTokenChange);
    window.addEventListener("sslert.tokenchange", onTokenChange);
    return () => {
      window.removeEventListener("storage", onTokenChange);
      window.removeEventListener("sslert.tokenchange", onTokenChange);
    };
  }, []);
  const isLoginRoute = location.pathname === "/login";
  return (
    <div className="min-h-full">
      {!isLoginRoute && (
        <header className="sticky top-0 z-30 border-b border-slate-200 bg-white/80 backdrop-blur">
          <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-3">
            <Link to="/" className="flex items-center gap-2 text-slate-900">
              <ShieldCheck className="h-6 w-6 text-sky-600" />
              <span className="text-lg font-semibold">SSLert</span>
            </Link>
            <nav className="flex items-center gap-2">
              <Link to="/">
                <Button
                  variant={location.pathname === "/" ? "secondary" : "ghost"}
                  size="sm"
                >
                  Dashboard
                </Button>
              </Link>
              <Link to="/audit">
                <Button
                  variant={location.pathname === "/audit" ? "secondary" : "ghost"}
                  size="sm"
                >
                  Audit
                </Button>
              </Link>
              <Button size="sm" onClick={() => setAddOpen(true)}>
                + Add
              </Button>
              {hasToken && (
                <Button
                  size="sm"
                  variant="ghost"
                  data-testid="signout-button"
                  onClick={() => clearApiToken()}
                  title="Clear stored token"
                >
                  <LogOut className="h-4 w-4" />
                </Button>
              )}
            </nav>
          </div>
        </header>
      )}
      <main className={isLoginRoute ? "" : "mx-auto max-w-6xl px-6 py-6"}>
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route
            path="/"
            element={
              <RequireAuth>
                <Dashboard />
              </RequireAuth>
            }
          />
          <Route
            path="/domains/:id"
            element={
              <RequireAuth>
                <DomainDetail />
              </RequireAuth>
            }
          />
          <Route
            path="/audit"
            element={
              <RequireAuth>
                <AuditLog />
              </RequireAuth>
            }
          />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>
      {!isLoginRoute && (
        <AddDomainDialog open={addOpen} onOpenChange={setAddOpen} />
      )}
    </div>
  );
}
