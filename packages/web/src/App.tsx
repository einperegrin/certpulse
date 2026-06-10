import * as React from "react";
import { Routes, Route, Link, useLocation, Navigate } from "react-router-dom";
import { ShieldCheck } from "lucide-react";
import { Button } from "./components/ui/button";
import { AddDomainDialog } from "./components/AddDomainDialog";
import { Dashboard } from "./pages/Dashboard";
import { DomainDetail } from "./pages/DomainDetail";
import { AuditLog } from "./pages/AuditLog";

export default function App() {
  const [addOpen, setAddOpen] = React.useState(false);
  const location = useLocation();
  return (
    <div className="min-h-full">
      <header className="sticky top-0 z-30 border-b border-slate-200 bg-white/80 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-3">
          <Link to="/" className="flex items-center gap-2 text-slate-900">
            <ShieldCheck className="h-6 w-6 text-sky-600" />
            <span className="text-lg font-semibold">CertPulse</span>
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
          </nav>
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-6 py-6">
        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/domains/:id" element={<DomainDetail />} />
          <Route path="/audit" element={<AuditLog />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>
      <AddDomainDialog open={addOpen} onOpenChange={setAddOpen} />
    </div>
  );
}
