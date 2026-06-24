import * as React from "react";
import { Navigate, useLocation } from "react-router-dom";
import { getApiToken } from "../lib/api";

// Route guard — redirects to /login if no token; the login form
// does the real /api probe to validate it.
export function RequireAuth({ children }: { children: React.ReactElement }) {
  const location = useLocation();
  const token = getApiToken();
  if (!token) {
    return (
      <Navigate
        to="/login"
        replace
        state={{ from: location.pathname + location.search }}
      />
    );
  }
  return children;
}
