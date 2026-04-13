import { useEffect } from "preact/hooks";
import { useI18n } from "../lib/i18n";
import { Flash } from "../components/Flash";
import { CLERK_ACCOUNTS_URL } from "../lib/api";

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

export function SignInPage() {
  const { t, lang } = useI18n();
  const params = new URLSearchParams(window.location.search);
  const error = params.get("error") || "";
  const notice = params.get("notice") || "";

  useEffect(() => {
    document.title = t("signInTitle");
  }, [lang]);

  const headlineClass =
    lang === "zh-hans"
      ? "font-serif-sc"
      : lang === "zh-hant"
        ? "font-serif-tc"
        : "font-serif";

  const handleSignIn = () => {
    const returnUrl = `${window.location.origin}${BASE}/dashboard/`;
    window.location.href = `${CLERK_ACCOUNTS_URL}/sign-in?redirect_url=${encodeURIComponent(returnUrl)}`;
  };

  return (
    <div class="min-h-screen grid place-items-center p-8 max-md:p-5">
      <section class="w-full max-w-[1040px] grid grid-cols-[1.1fr_0.9fr] max-md:grid-cols-1 rounded-3xl overflow-hidden bg-surface/82 border border-line shadow-[0_20px_60px_rgba(0,0,0,0.06)]">
        {/* Left: Story panel */}
        <div class="p-12 max-md:p-7 max-md:pb-7 grid content-between gap-8 border-r max-md:border-r-0 max-md:border-b border-line">
          <div class="grid gap-4">
            <span class="inline-flex items-center gap-2 text-[13px] font-semibold tracking-wide text-accent">
              <SyncIcon />
              {t("brandName")}
            </span>
            <h1
              class={`m-0 text-[clamp(2.4rem,5vw,3.6rem)] leading-[1.05] font-bold tracking-tight ${headlineClass}`}
            >
              {t("signInHeadline")}
            </h1>
            <p class="m-0 max-w-[480px] text-muted text-base leading-relaxed">
              {t("signInSub")}
            </p>
          </div>
          <div class="grid gap-2.5 mt-7">
            <FeatureCard title={t("feat1Title")} desc={t("feat1Desc")} />
            <FeatureCard title={t("feat2Title")} desc={t("feat2Desc")} />
            <FeatureCard title={t("feat3Title")} desc={t("feat3Desc")} />
          </div>
        </div>

        {/* Right: Sign-in card */}
        <div class="p-12 max-md:p-8 grid content-center gap-5 bg-white">
          <h2 class="m-0 text-2xl font-bold leading-tight">{t("signInCardTitle")}</h2>
          <p class="m-0 text-muted text-[0.94rem] leading-relaxed">
            {t("signInCardLead")}
          </p>
          {error && <Flash type="error" message={error} />}
          {notice && <Flash type="success" message={notice} />}
          <button
            type="button"
            onClick={handleSignIn}
            class="border-0 rounded-[14px] py-4 px-[18px] bg-accent text-white font-semibold text-base cursor-pointer shadow-[0_4px_14px_rgba(37,99,235,0.2)] transition-all duration-200 hover:bg-accent-hover hover:shadow-[0_6px_20px_rgba(37,99,235,0.25)]"
          >
            {t("signInBtn")}
          </button>
        </div>
      </section>
    </div>
  );
}

function FeatureCard({ title, desc }: { title: string; desc: string }) {
  return (
    <div class="py-3.5 px-4 rounded-[14px] bg-accent-soft border border-accent/[0.06]">
      <strong class="block mb-1 text-[0.94rem] text-ink">{title}</strong>
      <span class="text-muted text-[0.88rem] leading-relaxed">{desc}</span>
    </div>
  );
}

function SyncIcon() {
  return (
    <svg
      class="w-[18px] h-[18px]"
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
