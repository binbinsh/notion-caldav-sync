import { I18nProvider } from "./lib/i18n";
import { SignInPage } from "./pages/SignIn";
import { DashboardPage } from "./pages/Dashboard";

function getPage(): "sign-in" | "dashboard" {
  const path = window.location.pathname;
  const base = import.meta.env.BASE_URL.replace(/\/$/, "");
  const relative = path.startsWith(base) ? path.slice(base.length) : path;
  if (relative === "/dashboard" || relative === "/dashboard/") return "dashboard";
  return "sign-in";
}

export function App() {
  const page = getPage();
  return (
    <I18nProvider>
      {page === "dashboard" ? <DashboardPage /> : <SignInPage />}
    </I18nProvider>
  );
}
