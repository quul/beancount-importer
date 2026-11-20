import { useId, useLayoutEffect, useRef, useState, type RefObject } from "react";
import type { ParsedAccount } from "../../src/shared/types.js";

type AccountOption = Pick<ParsedAccount, "account" | "closedAt">;

export default function AccountSelect({ value, accounts, onChange, disabled, funding = false, label, inputId, autoHighlight = false, confirmCurrent = false, matchReason, optionsBottomBoundary }: {
  value: string; accounts: AccountOption[]; onChange: (value: string) => void;
  disabled?: boolean; funding?: boolean; label: string; inputId?: string;
  autoHighlight?: boolean; confirmCurrent?: boolean; matchReason?: string;
  optionsBottomBoundary?: RefObject<HTMLElement>;
}) {
  const listId = useId();
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState<string | null>(null);
  const [activeIndex, setActiveIndex] = useState(-1);
  const allowed = (option: AccountOption) => !funding || /^(Assets|Liabilities):/.test(option.account);
  const current = value ? accounts.find((option) => option.account === value && allowed(option)) : undefined;
  const hint = current?.closedAt ? `关闭于 ${current.closedAt}` : value && !current ? "未在账本定义" : undefined;
  const description = [hint && `${listId}-hint`, matchReason && `${listId}-match`].filter(Boolean).join(" ") || undefined;
  const title = [hint ? `${value}（${hint}）` : value, matchReason].filter(Boolean).join("\n") || undefined;
  const nameStart = value.lastIndexOf("-") + 1;
  const hasName = nameStart > 0 && nameStart < value.length;
  const words = query?.normalize("NFKC").toLowerCase().trim().split(/\s+/).filter(Boolean) ?? [];
  const matches = open ? accounts.filter((option) => {
    if (!allowed(option)) return false;
    const name = option.account.normalize("NFKC").toLowerCase();
    return words.every((word) => name.includes(word));
  }) : [];
  if (autoHighlight && current && !words.length) {
    const index = matches.indexOf(current);
    if (index > 0) matches.unshift(...matches.splice(index, 1));
  }
  const activeOption = matches[activeIndex];
  const activeId = activeOption ? `${listId}-${activeIndex}` : undefined;

  useLayoutEffect(() => {
    if (!open) return;
    const field = input.current!;
    const menu = list.current!;
    const viewport = window.visualViewport;
    const place = (event?: Event) => {
      if (event?.target === menu) return;
      const bounds = field.getBoundingClientRect();
      const screenTop = viewport?.offsetTop ?? 0;
      const screenBottom = screenTop + (viewport?.height ?? window.innerHeight);
      const above = bounds.top - screenTop - 10;
      const boundaryTop = optionsBottomBoundary?.current?.getBoundingClientRect().top ?? screenBottom;
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
  }, [open, optionsBottomBoundary]);

  useLayoutEffect(() => {
    if (activeId) document.getElementById(activeId)?.scrollIntoView({ block: "nearest" });
  }, [activeId]);

  const close = () => { setOpen(false); setQuery(null); setActiveIndex(-1); };
  const openChoices = () => {
    if (!open && autoHighlight) setActiveIndex(0);
    setOpen(true);
  };
  const select = (account: string) => {
    close();
    if (account !== value || confirmCurrent) onChange(account);
  };

  return <div className={`account-select${matchReason ? " funding-unverified" : ""}`}>
    <div className="account-select-field">
      <input ref={input} id={inputId} role="combobox" aria-label={label} aria-autocomplete="list" aria-expanded={open}
        className={hasName ? "has-account-name" : undefined}
        aria-controls={open ? listId : undefined} aria-activedescendant={activeId} aria-describedby={description}
        title={title} spellCheck={false} autoComplete="off" disabled={disabled}
        value={query ?? value} placeholder="搜索账户" onFocus={(event) => { event.currentTarget.select(); openChoices(); }}
        onClick={openChoices} onBlur={close}
        onChange={(event) => { setQuery(event.target.value); setActiveIndex(0); setOpen(true); }}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing) return;
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            setOpen(true);
            setActiveIndex((index) => !open ? 0 : Math.max(0, Math.min(matches.length - 1, index + (event.key === "ArrowDown" ? 1 : -1))));
          } else if (event.key === "Enter") {
            event.preventDefault();
            if (activeOption) select(activeOption.account);
            else if (matches.length === 1) select(matches[0].account);
            else { setOpen(true); setActiveIndex(0); }
          } else if (event.key === "Escape" && open) {
            event.preventDefault();
            event.stopPropagation();
            close();
          }
        }} />
      {hasName && <span className="account-selected-value" aria-hidden="true">
        <span className="account-path">{value.slice(0, nameStart)}</span>
        <span className="account-name">{value.slice(nameStart)}</span>
      </span>}
    </div>
    {hint && <small id={`${listId}-hint`} className="account-value-hint">{hint}</small>}
    {matchReason && <span id={`${listId}-match`} hidden>{matchReason}</span>}
    {open && <ul id={listId} ref={list} className="account-options" role="listbox" aria-label={label}>
      {matches.length ? matches.map((option, index) => <li key={option.account} id={`${listId}-${index}`} role="option"
        aria-selected={option.account === value} className={`account-option${index === activeIndex ? " active" : ""}`}
        onMouseDown={(event) => event.preventDefault()} onClick={() => select(option.account)}>
        <span>{option.account}</span>{option.closedAt && <small>关闭于 {option.closedAt}</small>}
      </li>) : <li role="option" aria-disabled="true" className="account-empty">{accounts.some(allowed) ? "没有匹配的账户" : "没有可用账户"}</li>}
    </ul>}
  </div>;
}
