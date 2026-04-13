import { useI18n, type Lang } from "../lib/i18n";
import { signOut } from "../lib/api";

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

export function Topbar({ userName }: { userName?: string }) {
  const { lang, setLang, t } = useI18n();

  const handleLogout = () => {
    signOut();
  };

  return (
    <header class="flex items-center justify-between px-6 py-4 border-b border-line bg-surface">
      <a
        href={`${BASE}/`}
        class="flex items-center gap-2 text-[15px] font-semibold text-ink no-underline"
      >
        <SyncIcon />
        {t("brandName")}
      </a>
      <div class="flex items-center gap-3">
        {userName && (
          <span class="text-[13px] text-muted">{userName}</span>
        )}
        <LangBar lang={lang} setLang={setLang} />
        {userName && (
          <button
            type="button"
            onClick={handleLogout}
            class="px-2.5 py-1 border border-line rounded-md text-[11px] font-medium text-muted cursor-pointer transition-all duration-150 bg-transparent hover:bg-red/8 hover:text-red hover:border-red/20"
          >
            {t("logoutBtn")}
          </button>
        )}
      </div>
    </header>
  );
}

function LangBar({ lang, setLang }: { lang: Lang; setLang: (l: Lang) => void }) {
  const langs: { id: Lang; label: string }[] = [
    { id: "en", label: "EN" },
    { id: "zh-hans", label: "简体" },
    { id: "zh-hant", label: "繁體" },
  ];
  return (
    <div class="flex gap-0.5">
      {langs.map((l) => (
        <button
          key={l.id}
          onClick={() => setLang(l.id)}
          class={`px-2 py-1 border rounded-md text-[11px] font-medium cursor-pointer transition-all duration-150 ${
            lang === l.id
              ? "bg-accent-soft text-accent border-accent/15"
              : "bg-transparent text-muted border-line hover:bg-accent-soft hover:text-accent hover:border-accent/15"
          }`}
        >
          {l.label}
        </button>
      ))}
    </div>
  );
}

function SyncIcon() {
  return (
    <svg
      class="w-[18px] h-[18px] text-accent"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
    >
      <path d="M17 1l4 4-4 4" />
      <path d="M3 11V9a4 4 0 014-4h14" />
      <path d="M7 23l-4-4 4-4" />
      <path d="M21 13v2a4 4 0 01-4 4H3" />
    </svg>
  );
}
