import { useI18n } from "../lib/i18n";

const LEGAL_ORIGIN = "https://superplanner.ai";

export function Footer() {
  const { t } = useI18n();
  const year = new Date().getFullYear();

  return (
    <footer className="border-t border-line px-6 py-8 text-center max-sm:px-4">
      <p className="m-0 text-[13px] text-subtle">
        &copy; {year}{" "}
        <a className="text-muted no-underline hover:underline" href="https://gridheap.com/">
          Grid Heap
        </a>
        .{" "}
        {t("footerCopyright")} &nbsp;|&nbsp;{" "}
        <a className="text-muted no-underline hover:underline" href={`${LEGAL_ORIGIN}/privacy-policy`}>
          {t("footerPrivacy")}
        </a>{" "}
        &nbsp;|&nbsp;{" "}
        <a className="text-muted no-underline hover:underline" href={`${LEGAL_ORIGIN}/terms-of-use`}>
          {t("footerTerms")}
        </a>
      </p>
    </footer>
  );
}
