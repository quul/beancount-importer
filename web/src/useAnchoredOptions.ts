import { useLayoutEffect, type RefObject } from "react";

export default function useAnchoredOptions(
  open: boolean,
  input: RefObject<HTMLInputElement>,
  list: RefObject<HTMLUListElement>,
  bottomBoundary?: RefObject<HTMLElement>,
  anchor?: RefObject<HTMLElement>,
) {
  useLayoutEffect(() => {
    const field = input.current, menu = list.current;
    if (!open || !field || !menu) return;
    const viewport = window.visualViewport;
    const place = (event?: Event) => {
      if (event?.target === menu) return;
      const bounds = (anchor?.current ?? field).getBoundingClientRect();
      const screenTop = viewport?.offsetTop ?? 0;
      const screenBottom = screenTop + (viewport?.height ?? window.innerHeight);
      const above = bounds.top - screenTop - 10;
      const boundaryTop = bottomBoundary?.current?.getBoundingClientRect().top ?? screenBottom;
      const below = Math.min(screenBottom, boundaryTop) - bounds.bottom - 10;
      const flip = below < 220 && above > below;
      const width = Math.min(Math.max(bounds.width, 280), document.documentElement.clientWidth - 16);
      menu.style.width = `${width}px`;
      menu.style.left = `${Math.max(8, Math.min(bounds.left, document.documentElement.clientWidth - width - 8))}px`;
      menu.style.maxHeight = `${Math.max(0, Math.min(264, flip ? above : below))}px`;
      menu.style.top = flip ? "auto" : `${bounds.bottom + 4}px`;
      menu.style.bottom = flip ? `${window.innerHeight - bounds.top + 4}px` : "auto";
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    viewport?.addEventListener("resize", place);
    viewport?.addEventListener("scroll", place);
    const observer = new IntersectionObserver(([entry]) => { menu.style.visibility = entry.isIntersecting ? "" : "hidden"; });
    observer.observe(field);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
      viewport?.removeEventListener("resize", place);
      viewport?.removeEventListener("scroll", place);
      observer.disconnect();
    };
  }, [open, input, list, bottomBoundary, anchor]);
}
