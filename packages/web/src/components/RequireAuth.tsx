import * as React from "react";
import { Navigate, useLocation } from "react-router-dom";
import { getApiToken } from "../lib/api";

/**
 * Route guard. If there is no token in localStorage we redirect to
 * `/login` and stash the attempted path in `location.state.from` so
 * the login page can return there on success.
 *
 * Why this lives in a component rather than a router wrapper: it has
 * to read `localStorage` lazily — running it during the initial render
 * is fine (it cannot throw, the helper is try/caught) but we still
 * want it inside React so a future "Sign out" call that clears the
 * token triggers a re-render and a re-evaluation.
 *
 * NOTE on token validation: this guard only checks "is there a
 * token?" — it does NOT call the API. The login page does that on
 * submit. Validating every render would mean every navigation = a
 * network round-trip, which is unnecessary because the token does
 * not change between renders without a page action.
 */
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
