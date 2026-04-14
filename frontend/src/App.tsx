import { I18nProvider } from "./lib/i18n";
import { DashboardPage } from "./pages/Dashboard";

export function App() {
  return (
    <I18nProvider>
      <DashboardPage />
    </I18nProvider>
  );
}
