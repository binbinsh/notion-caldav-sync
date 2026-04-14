import { useI18n, type Lang } from "../lib/i18n";
import { signOut } from "../lib/api";
import { getAppBasePath } from "../lib/auth";

const BASE = getAppBasePath();

export function Topbar({
  userName,
}: {
  userName?: string;
}) {
  const { lang, setLang, t } = useI18n();

  return (
    <header class="sticky top-0 z-40 backdrop-blur-md bg-surface/80 border-b border-line">
      <div class="max-w-[960px] mx-auto px-6 h-14 flex items-center justify-between">
        <a
          href={`${BASE}/`}
          class="flex items-center gap-2.5 text-[15px] font-semibold text-ink no-underline tracking-[-0.01em]"
        >
          <div class="w-7 h-7 rounded-lg bg-accent/10 flex items-center justify-center">
            <SyncIcon />
          </div>
          {t("brandName")}
        </a>
        <div class="flex items-center gap-2">
          <LangBar lang={lang} setLang={setLang} />
          {userName && (
            <div class="flex items-center gap-2 ml-1">
              <div class="w-6 h-6 rounded-full bg-accent/10 text-accent text-[11px] font-bold flex items-center justify-center uppercase">
                {userName.charAt(0)}
              </div>
              <button
                type="button"
                onClick={() => signOut()}
                class="text-[12px] font-medium text-muted bg-transparent border-0 cursor-pointer px-0 hover:text-red transition-colors"
              >
                {t("logoutBtn")}
              </button>
            </div>
          )}
        </div>
      </div>
    </header>
  );
}

function LangBar({ lang, setLang }: { lang: Lang; setLang: (l: Lang) => void }) {
  const langs: { id: Lang; label: string }[] = [
    { id: "en", label: "EN" },
    { id: "zh-hans", label: "\u7B80" },
    { id: "zh-hant", label: "\u7E41" },
  ];
  return (
    <div class="flex rounded-lg border border-line overflow-hidden">
      {langs.map((l) => (
        <button
          key={l.id}
          onClick={() => setLang(l.id)}
          class={`px-2 py-1 text-[11px] font-medium cursor-pointer transition-colors border-0 ${
            lang === l.id
              ? "bg-accent text-white"
              : "bg-transparent text-muted hover:bg-accent-soft hover:text-accent"
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
      class="w-3.5 h-3.5 text-accent"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2.5"
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
