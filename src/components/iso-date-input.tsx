"use client";

import { useEffect, useRef, useState, type ComponentProps } from "react";
import { validDate } from "../lib/money";
import { CalendarDays } from "lucide-react";

type Props = Omit<ComponentProps<"input">, "type" | "value" | "min" | "max"> & {
  value: string;
  min?: string;
  max?: string;
  precision?: "date" | "month";
};

// Keep ISO text visible while using the browser's calendar for date selection.
export function ISODateInput({
  value,
  min,
  max,
  precision = "date",
  onChange,
  onBlur,
  ...props
}: Props) {
  const input = useRef<HTMLInputElement>(null);
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const format = precision === "month" ? "YYYY-MM" : "YYYY-MM-DD";
  const pattern =
    precision === "month" ? "[0-9]{4}-[0-9]{2}" : "[0-9]{4}-[0-9]{2}-[0-9]{2}";
  const validate = (text: string) => {
    if (!text) return "";
    try {
      if (!new RegExp(`^${pattern}$`).test(text)) throw new Error();
      validDate(precision === "month" ? `${text}-01` : text);
    } catch {
      return `Enter a valid ${precision} as ${format}.`;
    }
    if (min && text < min) return `Enter a ${precision} on or after ${min}.`;
    if (max && text > max) return `Enter a ${precision} on or before ${max}.`;
    return "";
  };
  useEffect(() => {
    input.current?.setCustomValidity(validate(draft));
  }, [draft, min, max, precision]);
  return (
    <span className="iso-date-input">
      <input
        {...props}
        ref={input}
        type="text"
        value={draft}
        pattern={pattern}
        placeholder={format}
        title={format}
        maxLength={precision === "month" ? 7 : 10}
        onChange={(event) => {
          const text = event.target.value;
          setDraft(text);
          event.target.setCustomValidity(validate(text));
          // Keep the active reporting month valid while its replacement is typed.
          if (precision === "date" || (text && !validate(text)))
            onChange?.(event);
        }}
        onBlur={(event) => {
          if (precision === "month" && (!draft || validate(draft)))
            setDraft(value);
          onBlur?.(event);
        }}
      />
      <span className="iso-date-picker">
        <CalendarDays size={16} aria-hidden="true" />
        <input
          type={precision}
          aria-label={precision === "month" ? "Choose month" : "Choose date"}
          value={draft && !validate(draft) ? draft : ""}
          min={min}
          max={max}
          disabled={props.disabled || props.readOnly}
          onClick={(event) => {
            // The real input remains clickable for browsers without showPicker.
            event.currentTarget.showPicker?.();
          }}
          onChange={(event) => {
            setDraft(event.target.value);
            onChange?.(event);
          }}
        />
      </span>
    </span>
  );
}
