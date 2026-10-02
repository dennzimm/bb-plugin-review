import { useId, useMemo, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

export interface ComboboxOption {
  key: string;
  /** Text written into the input when the option is picked. */
  value: string;
  group: string;
  primary: string;
  secondary?: string;
  badge?: string;
}

const MAX_SHOWN = 60;

/** Every whitespace-separated word of the query must appear somewhere in the option. */
function matches(option: ComboboxOption, words: readonly string[]): boolean {
  const haystack = `${option.value} ${option.primary} ${option.secondary ?? ""}`.toLowerCase();
  return words.every((word) => haystack.includes(word));
}

export function Combobox({
  value,
  onChange,
  onPick,
  options,
  placeholder,
  loading = false,
  emptyText = "No matches",
  autoFocus,
  required,
}: {
  value: string;
  onChange(next: string): void;
  onPick(option: ComboboxOption): void;
  options: readonly ComboboxOption[];
  placeholder?: string;
  loading?: boolean;
  emptyText?: string;
  autoFocus?: boolean;
  required?: boolean;
}) {
  const listId = useId();
  const listRef = useRef<HTMLUListElement>(null);
  const [open, setOpen] = useState(false);
  const [highlighted, setHighlighted] = useState(0);

  const shown = useMemo(() => {
    const words = value.toLowerCase().split(/\s+/).filter(Boolean);
    return options.filter((option) => matches(option, words)).slice(0, MAX_SHOWN);
  }, [options, value]);
  const active = open ? shown[Math.min(highlighted, shown.length - 1)] : undefined;

  const pick = (option: ComboboxOption) => {
    onPick(option);
    setOpen(false);
  };

  const move = (delta: number) => {
    if (shown.length === 0) return;
    const next = (Math.min(highlighted, shown.length - 1) + delta + shown.length) % shown.length;
    setHighlighted(next);
    listRef.current?.querySelector(`[data-index="${next}"]`)?.scrollIntoView({ block: "nearest" });
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (!open) {
        setOpen(true);
        return;
      }
      move(event.key === "ArrowDown" ? 1 : -1);
    } else if (event.key === "Enter" && active !== undefined) {
      // Only intercept Enter while a suggestion is highlighted; otherwise it submits the form.
      event.preventDefault();
      pick(active);
    } else if (event.key === "Escape" && open) {
      event.preventDefault();
      setOpen(false);
    }
  };

  return (
    <div className="relative">
      <Input
        value={value}
        onChange={(event) => {
          onChange(event.target.value);
          setHighlighted(0);
          setOpen(true);
        }}
        // Not on focus: the field is autofocused, and an unrequested list would cover the page.
        onClick={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onKeyDown={onKeyDown}
        placeholder={placeholder}
        autoFocus={autoFocus}
        required={required}
        autoComplete="off"
        spellCheck={false}
        role="combobox"
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={active === undefined ? undefined : `${listId}-${active.key}`}
      />
      {open ? (
        <ul
          ref={listRef}
          id={listId}
          role="listbox"
          // Keep focus in the input so blur does not close the list before the click lands.
          onMouseDown={(event) => event.preventDefault()}
          className="absolute inset-x-0 top-full z-50 mt-1 max-h-80 overflow-y-auto rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-md"
        >
          {shown.length === 0 ? (
            <li className="px-2 py-1.5 text-sm text-muted-foreground">{loading ? "Loading…" : emptyText}</li>
          ) : (
            shown.map((option, index) => (
              <li key={option.key} role="presentation">
                {index === 0 || shown[index - 1].group !== option.group ? (
                  <div className="px-2 pb-1 pt-2 text-xs font-medium text-muted-foreground">{option.group}</div>
                ) : null}
                <div
                  id={`${listId}-${option.key}`}
                  data-index={index}
                  role="option"
                  aria-selected={option === active}
                  onMouseEnter={() => setHighlighted(index)}
                  onClick={() => pick(option)}
                  className={cn(
                    "cursor-default rounded-sm px-2 py-1.5",
                    option === active && "bg-accent text-accent-foreground",
                  )}
                >
                  <div className="flex items-center gap-2 text-sm">
                    <span className="min-w-0 flex-1 truncate">{option.primary}</span>
                    {option.badge ? (
                      <span className="shrink-0 rounded bg-muted px-1.5 text-[10px] uppercase text-muted-foreground">{option.badge}</span>
                    ) : null}
                  </div>
                  {option.secondary ? <div className="truncate text-xs text-muted-foreground">{option.secondary}</div> : null}
                </div>
              </li>
            ))
          )}
        </ul>
      ) : null}
    </div>
  );
}
