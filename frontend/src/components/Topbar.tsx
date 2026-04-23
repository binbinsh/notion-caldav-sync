import { UserProfile, useClerk } from "@clerk/react";
import { useEffect, useState } from "react";
import { useI18n, type Lang } from "../lib/i18n";
import { getAppBasePath } from "../lib/auth";

const BASE = getAppBasePath();

export function Topbar({
  userName,
}: {
  userName?: string;
}) {
  const { lang, setLang, t } = useI18n();
  const { signOut } = useClerk();
  const [accountOpen, setAccountOpen] = useState(false);

  const handleSignOut = async () => {
    setAccountOpen(false);
    await signOut({ redirectUrl: `${window.location.origin}${BASE}/` });
  };

  useEffect(() => {
    if (!accountOpen) {
      return;
    }

    const previousOverflow = document.body.style.overflow;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setAccountOpen(false);
      }
    };

    document.body.style.overflow = "hidden";
    document.addEventListener("keydown", onKeyDown);

    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [accountOpen]);

  return (
    <>
      <header className="sticky top-0 z-40 backdrop-blur-md bg-surface/80 border-b border-line">
        <div className="mx-auto flex h-14 max-w-[1040px] items-center justify-between px-6 max-sm:px-4">
          <a
            href={`${BASE}/`}
            aria-label={t("brandName")}
            className="flex items-center gap-3 text-[15px] font-semibold text-ink no-underline"
          >
            <div className="w-7 h-7 rounded-lg bg-accent/10 flex items-center justify-center">
              <SyncIcon />
            </div>
            <span>{t("brandName")}</span>
          </a>
          <div className="flex items-center gap-2">
            <LangBar lang={lang} setLang={setLang} />
            {userName && (
              <button
                type="button"
                onClick={() => setAccountOpen(true)}
                className="ml-1 flex items-center gap-2 rounded-lg border-0 bg-transparent px-1.5 py-1.5 text-[12px] font-medium text-muted cursor-pointer transition-colors hover:bg-accent-soft hover:text-ink"
              >
                <div className="w-6 h-6 rounded-full bg-accent/10 text-accent text-[11px] font-bold flex items-center justify-center uppercase">
                  {userName.charAt(0)}
                </div>
                <span>{userName}</span>
              </button>
            )}
          </div>
        </div>
      </header>

      <div
        className={`fixed inset-0 z-[80] items-center justify-center bg-ink/15 p-3 backdrop-blur-sm ${accountOpen ? "flex" : "hidden"}`}
        onClick={(event) => {
          if (event.target === event.currentTarget) {
            setAccountOpen(false);
          }
        }}
        role="dialog"
        aria-modal="true"
        aria-labelledby="account-dialog-title"
      >
        <div className="relative max-h-[calc(100vh-1.5rem)] max-w-[calc(100vw-1.5rem)]">
          <h2 id="account-dialog-title" className="sr-only">
            {t("accountTitle")}
          </h2>
          <div className="absolute right-3 top-3 z-10 flex items-center gap-2">
            <button
              type="button"
              onClick={() => void handleSignOut()}
              className="inline-flex h-9 items-center justify-center rounded-full border border-line bg-surface/90 px-3 text-sm font-medium text-muted shadow-sm backdrop-blur transition-colors hover:text-ink"
            >
              {t("signOut")}
            </button>
            <button
              type="button"
              onClick={() => setAccountOpen(false)}
              className="h-9 w-9 rounded-full border border-line bg-surface/90 text-muted shadow-sm backdrop-blur transition-colors hover:text-ink"
              aria-label={t("closeAccount")}
            >
              &times;
            </button>
          </div>
          <div className="max-h-[calc(100vh-1.5rem)] overflow-auto">
            <div className="inline-flex min-h-0 items-start justify-center">
              <UserProfile routing="hash" />
            </div>
          </div>
        </div>
      </div>
    </>
  );
}

function LangBar({ lang, setLang }: { lang: Lang; setLang: (l: Lang) => void }) {
  const langs: { id: Lang; label: string }[] = [
    { id: "en", label: "EN" },
    { id: "zh-hans", label: "\u7B80" },
    { id: "zh-hant", label: "\u7E41" },
  ];
  return (
    <div className="flex rounded-lg border border-line overflow-hidden">
      {langs.map((l) => (
        <button
          key={l.id}
          onClick={() => setLang(l.id)}
          className={`px-2 py-1 text-[11px] font-medium cursor-pointer transition-colors border-0 ${
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
      className="w-3.5 h-3.5 text-accent"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M17 1l4 4-4 4" />
      <path d="M3 11V9a4 4 0 014-4h14" />
      <path d="M7 23l-4-4 4-4" />
      <path d="M21 13v2a4 4 0 01-4 4H3" />
    </svg>
  );
}
