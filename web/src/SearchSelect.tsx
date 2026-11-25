import { useId, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import useAnchoredOptions from "./useAnchoredOptions";

interface SearchOption {
  value: string;
  label?: string;
  detail?: string;
}

export default function SearchSelect({ value, options, onChange, disabled, label, inputId, placeholder, inputClassName,
  selectedContent, emptyMessage, createOption, autoHighlight = false, confirmCurrent = false,
  hint, matchReason, validationMessage, optionsBottomBoundary }: {
  value: string; options: SearchOption[]; onChange: (value: string) => void;
  disabled?: boolean; label: string; inputId?: string; placeholder: string; inputClassName?: string;
  selectedContent?: ReactNode; emptyMessage: string; createOption?: (query: string) => SearchOption | undefined;
  autoHighlight?: boolean; confirmCurrent?: boolean; hint?: string; matchReason?: string; validationMessage?: string;
  optionsBottomBoundary?: RefObject<HTMLElement>;
}) {
  const listId = useId();
  const input = useRef<HTMLInputElement>(null);
  const control = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState<string | null>(null);
  const [activeIndex, setActiveIndex] = useState(-1);
  const displayedHint = validationMessage || hint;
  const description = [displayedHint && `${listId}-hint`, matchReason && `${listId}-match`].filter(Boolean).join(" ") || undefined;
  const title = [hint ? `${value}（${hint}）` : value, matchReason].filter(Boolean).join("\n") || undefined;
  const words = query?.normalize("NFKC").toLowerCase().trim().split(/\s+/).filter(Boolean) ?? [];
  const matches = open ? options.filter(({ value }) => {
    const name = value.normalize("NFKC").toLowerCase();
    return words.every((word) => name.includes(word));
  }) : [];
  if (autoHighlight && !words.length) {
    const index = matches.findIndex((option) => option.value === value);
    if (index > 0) matches.unshift(...matches.splice(index, 1));
  }
  if (open && query && createOption && !matches.length) {
    const option = createOption(query);
    if (option) matches.push(option);
  }
  const activeOption = matches[activeIndex];
  const activeId = activeOption ? `${listId}-${activeIndex}` : undefined;

  useAnchoredOptions(open, input, list, optionsBottomBoundary, validationMessage ? control : undefined);

  useLayoutEffect(() => {
    if (activeId) document.getElementById(activeId)?.scrollIntoView({ block: "nearest" });
  }, [activeId]);

  const close = () => { setOpen(false); setQuery(null); setActiveIndex(-1); };
  const openChoices = () => {
    if (!open && autoHighlight) setActiveIndex(0);
    setOpen(true);
  };
  const select = (next: string) => {
    close();
    if (next !== value || confirmCurrent) onChange(next);
  };

  return <div ref={control} className={`account-select${matchReason ? " funding-unverified" : ""}`}>
    <div className="account-select-field">
      <input ref={input} id={inputId} role="combobox" aria-label={label} aria-autocomplete="list" aria-expanded={open}
        className={inputClassName} aria-controls={open ? listId : undefined} aria-activedescendant={activeId}
        aria-describedby={description} aria-invalid={Boolean(validationMessage) || undefined}
        title={title} spellCheck={false} autoComplete="off" disabled={disabled}
        value={query ?? value} placeholder={placeholder} onFocus={(event) => { event.currentTarget.select(); openChoices(); }}
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
            if (activeOption) select(activeOption.value);
            else if (matches.length === 1) select(matches[0].value);
            else { setOpen(true); setActiveIndex(0); }
          } else if (event.key === "Escape" && open) {
            event.preventDefault();
            event.stopPropagation();
            close();
          }
        }} />
      {selectedContent}
    </div>
    {displayedHint && <small id={`${listId}-hint`} className={validationMessage ? "review-field-error" : "account-value-hint"}>{displayedHint}</small>}
    {matchReason && <span id={`${listId}-match`} hidden>{matchReason}</span>}
    {open && <ul id={listId} ref={list} className="account-options" role="listbox" aria-label={label}>
      {matches.length ? matches.map((option, index) => <li key={option.value} id={`${listId}-${index}`} role="option"
        aria-selected={option.value === value} className={`account-option${index === activeIndex ? " active" : ""}`}
        onMouseDown={(event) => event.preventDefault()} onClick={() => select(option.value)}>
        <span>{option.label ?? option.value}</span>{option.detail && <small>{option.detail}</small>}
      </li>) : <li role="option" aria-disabled="true" className="account-empty">{emptyMessage}</li>}
    </ul>}
  </div>;
}
