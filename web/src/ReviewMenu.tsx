import { useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";

export default function ReviewMenu({ label, title, children }: {
  label: string;
  title: string;
  children: (close: () => void) => ReactNode;
}) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);

  const close = () => {
    setOpen(false);
    trigger.current?.focus({ preventScroll: true });
  };

  useLayoutEffect(() => {
    if (!open) return;
    const button = trigger.current!;
    const popup = panel.current!;
    const place = (event?: Event) => {
      if (event?.target === popup) return;
      const anchor = button.getBoundingClientRect();
      const above = anchor.top - 14;
      const below = window.innerHeight - anchor.bottom - 14;
      const flip = popup.scrollHeight > below && above > below;
      popup.style.maxHeight = `${Math.max(0, flip ? above : below)}px`;
      popup.style.left = `${Math.max(8, Math.min(anchor.right, document.documentElement.clientWidth - 8) - popup.offsetWidth)}px`;
      popup.style.top = flip ? "auto" : `${anchor.bottom + 6}px`;
      popup.style.bottom = flip ? `${window.innerHeight - anchor.top + 6}px` : "auto";
    };
    const dismiss = (event: Event) => {
      if (event.target instanceof Node && !button.contains(event.target) && !popup.contains(event.target)) setOpen(false);
    };
    const observer = new IntersectionObserver(([entry]) => {
      if (!entry.isIntersecting) setOpen(false);
    });
    place();
    observer.observe(button);
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    document.addEventListener("pointerdown", dismiss);
    document.addEventListener("focusin", dismiss);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
      document.removeEventListener("pointerdown", dismiss);
      document.removeEventListener("focusin", dismiss);
    };
  }, [open]);

  return <div className="review-menu" onKeyDown={(event) => {
    if (event.key !== "Escape" || event.defaultPrevented || !open) return;
    event.preventDefault();
    event.stopPropagation();
    close();
  }}>
    <button ref={trigger} type="button" className="btn small quiet review-menu-trigger"
      title={label} aria-label={label} aria-expanded={open} aria-controls={open ? id : undefined}
      onClick={() => setOpen((value) => !value)}>{title}</button>
    {open && <div className="review-menu-panel" id={id} ref={panel} role="group" aria-label={label}>
      {children(close)}
    </div>}
  </div>;
}
