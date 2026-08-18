import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";

export interface UxpDropdownOption {
  value: string;
  label: string;
  disabled?: boolean;
}

interface DropdownContextValue {
  openId: string | null;
  setOpenId: (id: string | null) => void;
}

const DropdownContext = createContext<DropdownContextValue | null>(null);

export function UxpDropdownProvider({ children }: { children: ReactNode }) {
  const [openId, setOpenId] = useState<string | null>(null);
  useEffect(() => {
    if (typeof window === "undefined") return;
    const close = () => setOpenId(null);
    window.addEventListener("blur", close);
    return () => window.removeEventListener("blur", close);
  }, []);
  return (
    <DropdownContext.Provider value={{ openId, setOpenId }}>
      <div
        className="uxp-dropdown-scope"
        onPointerDownCapture={(event) => {
          const target = event.target as Element;
          if (!target?.closest?.("[data-uxp-dropdown]")) setOpenId(null);
        }}
      >
        {children}
      </div>
    </DropdownContext.Provider>
  );
}

export function UxpDropdown({
  id,
  value,
  options,
  onChange,
  ariaLabel,
  disabled = false,
}: {
  id: string;
  value: string;
  options: UxpDropdownOption[];
  onChange: (value: string) => void;
  ariaLabel: string;
  disabled?: boolean;
}) {
  const shared = useContext(DropdownContext);
  const [localOpenId, setLocalOpenId] = useState<string | null>(null);
  const openId = shared?.openId ?? localOpenId;
  const setOpenId = shared?.setOpenId ?? setLocalOpenId;
  const open = openId === id && !disabled;
  const selectedIndex = Math.max(0, options.findIndex((option) => option.value === value));
  const [activeIndex, setActiveIndex] = useState(selectedIndex);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const selectedLabel = useMemo(
    () => options.find((option) => option.value === value)?.label ?? value,
    [options, value],
  );

  const openMenu = (index = selectedIndex) => {
    if (disabled) return;
    setActiveIndex(index);
    setOpenId(id);
  };
  const choose = (index: number) => {
    const option = options[index];
    if (!option || option.disabled) return;
    onChange(option.value);
    setOpenId(null);
    triggerRef.current?.focus();
  };
  const move = (direction: 1 | -1) => {
    if (!options.length) return;
    let next = activeIndex;
    for (let count = 0; count < options.length; count += 1) {
      next = (next + direction + options.length) % options.length;
      if (!options[next].disabled) break;
    }
    setActiveIndex(next);
  };
  const handleKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (disabled) return;
    if (event.key === "Escape") {
      if (open) {
        event.preventDefault();
        setOpenId(null);
      }
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (!open) openMenu(selectedIndex);
      else move(event.key === "ArrowDown" ? 1 : -1);
      return;
    }
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      if (open) choose(activeIndex);
      else openMenu();
    }
  };

  return (
    <span className={`uxp-dropdown ${disabled ? "is-disabled" : ""}`} data-uxp-dropdown={id}>
      <button
        ref={triggerRef}
        type="button"
        className="uxp-dropdown__trigger"
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={`${id}-listbox`}
        disabled={disabled}
        onClick={() => {
          if (disabled) return;
          if (open) setOpenId(null);
          else openMenu();
        }}
        onKeyDown={handleKeyDown}
      >
        <span className="uxp-dropdown__value">{selectedLabel}</span>
      </button>
      {open && (
        <span id={`${id}-listbox`} className="uxp-dropdown__list" role="listbox" aria-label={ariaLabel}>
          {options.map((option, index) => (
            <button
              type="button"
              role="option"
              aria-selected={option.value === value}
              className={`${index === activeIndex ? "is-active" : ""} ${option.value === value ? "is-selected" : ""}`.trim()}
              disabled={option.disabled}
              key={option.value}
              onPointerMove={() => setActiveIndex(index)}
              onClick={() => choose(index)}
            >
              {option.label}
            </button>
          ))}
        </span>
      )}
    </span>
  );
}
