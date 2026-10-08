import { useLayoutEffect, useState, type KeyboardEvent, type MouseEvent, type RefObject } from "react";
import { Lightbox } from "@/components/lightbox";
import { scrollToHeading } from "./report-toc";

interface GalleryImage {
  src: string;
  caption?: string;
  href?: string;
}

/** A check id such as "C2" in the first cell of the table row an image sits in, if any. */
const CHECK_ID_PATTERN = /^[A-Za-z]{1,4}-?\d{1,3}$/;

function captionFor(img: HTMLImageElement): string | undefined {
  const alt = img.alt.trim();
  const firstCell = img.closest("tr")?.querySelector("th, td")?.textContent?.trim() ?? "";
  const checkId = CHECK_ID_PATTERN.test(firstCell) ? firstCell : null;
  if (checkId && alt) return `${checkId} · ${alt}`;
  return checkId ?? (alt || undefined);
}

function collectImages(article: HTMLElement): { images: HTMLImageElement[]; gallery: GalleryImage[] } {
  const images = Array.from(article.querySelectorAll("img"));
  const gallery = images.map((img) => {
    const src = img.currentSrc || img.src;
    return { src, caption: captionFor(img), href: src };
  });
  return { images, gallery };
}

/**
 * Server-sanitized report HTML with fixed typography. Every image opens in a shared, navigable gallery;
 * in-page `#anchor` links scroll instead of touching the hash router.
 */
export function ReportArticle({
  html,
  title,
  articleRef,
}: {
  html: string;
  title: string;
  articleRef: RefObject<HTMLElement | null>;
}) {
  const [gallery, setGallery] = useState<GalleryImage[]>([]);
  const [index, setIndex] = useState<number | null>(null);

  // The content is server-rendered HTML, so wire up accessibility and link behaviour on the DOM once per document.
  useLayoutEffect(() => {
    const article = articleRef.current;
    if (!article) return;
    for (const img of article.querySelectorAll("img")) {
      img.tabIndex = 0;
      img.setAttribute("role", "button");
      img.setAttribute("aria-label", img.alt ? `Open image: ${img.alt}` : "Open image");
      img.loading = "lazy";
    }
    for (const link of article.querySelectorAll<HTMLAnchorElement>("a[href^='http']")) {
      link.target = "_blank";
      link.rel = "noopener noreferrer";
    }
    // The page header already shows the title; hide a leading identical H1 in case the server kept it.
    const first = article.firstElementChild;
    if (first instanceof HTMLHeadingElement && first.tagName === "H1" && first.textContent?.trim() === title.trim()) {
      first.hidden = true;
    }
  }, [html, title, articleRef]);

  const openImage = (img: HTMLImageElement) => {
    const article = articleRef.current;
    if (!article) return;
    const { images, gallery: next } = collectImages(article);
    const at = images.indexOf(img);
    if (at < 0) return;
    setGallery(next);
    setIndex(at);
  };

  const onClick = (e: MouseEvent<HTMLElement>) => {
    if (!(e.target instanceof Element)) return;
    const img = e.target.closest("img");
    if (img) {
      e.preventDefault();
      openImage(img);
      return;
    }
    const href = e.target.closest("a")?.getAttribute("href");
    // `#/…` is an app route and navigates normally; any other fragment is an in-page anchor.
    if (href?.startsWith("#") && !href.startsWith("#/")) {
      e.preventDefault();
      try {
        scrollToHeading(articleRef.current, decodeURIComponent(href.slice(1)));
      } catch {
        // malformed escape sequence in a hand-written anchor: ignore
      }
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    if ((e.key === "Enter" || e.key === " ") && e.target instanceof HTMLImageElement) {
      e.preventDefault();
      openImage(e.target);
    }
  };

  return (
    <>
      <article
        ref={articleRef}
        onClick={onClick}
        onKeyDown={onKeyDown}
        className={[
          "prose prose-zinc dark:prose-invert max-w-3xl",
          "prose-headings:scroll-mt-24 prose-headings:font-semibold",
          "prose-code:before:content-none prose-code:after:content-none",
          "[&_:not(pre)>code]:rounded [&_:not(pre)>code]:bg-muted [&_:not(pre)>code]:px-1.5 [&_:not(pre)>code]:py-0.5 [&_:not(pre)>code]:font-normal",
          "[&_table]:block [&_table]:overflow-x-auto",
          "[&_img]:max-h-[420px] [&_img]:w-auto [&_img]:max-w-full [&_img]:cursor-zoom-in [&_img]:rounded-md [&_img]:border",
          "[&_td_img]:max-h-40 [&_th_img]:max-h-40 [&_td_img]:my-0 [&_th_img]:my-0",
          "[&_img:focus-visible]:outline-2 [&_img:focus-visible]:outline-offset-2 [&_img:focus-visible]:outline-ring",
        ].join(" ")}
        dangerouslySetInnerHTML={{ __html: html }}
      />
      <Lightbox images={gallery} index={index} onIndexChange={setIndex} />
    </>
  );
}
