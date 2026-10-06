"use client";
import { useEffect, useRef } from "react";

export function useReviewShortcuts(blocked = false) {
  const container = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
      const root = container.current;
      if (
        !root ||
        blocked ||
        event.defaultPrevented ||
        event.repeat ||
        event.isComposing ||
        event.altKey ||
        event.shiftKey ||
        document.querySelector('[role="dialog"], dialog[open]')
      )
        return;
      const save = (event.ctrlKey || event.metaKey) && event.key === "Enter";
      if (!save && (event.ctrlKey || event.metaKey)) return;
      const target = event.target;
      if (
        !save &&
        target instanceof HTMLElement &&
        target.closest(
          'input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"]',
        )
      )
        return;
      const key = save ? "save" : event.key.toLowerCase();
      // Use the visible controls so disabled states and native form validation
      // apply equally to mouse and keyboard actions.
      const control = Array.from(
        root.querySelectorAll<HTMLElement>("[data-shortcut]"),
      ).find(
        (element) =>
          element.dataset.shortcut === key &&
          !element.matches(":disabled, [aria-disabled='true']") &&
          element.getClientRects().length > 0,
      );
      if (!control) return;
      event.preventDefault();
      if (control.dataset.shortcutFocus !== undefined) control.focus();
      else control.click();
    };
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [blocked]);
  return container;
}
