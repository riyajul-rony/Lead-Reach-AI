"use client";

import React, { useEffect, useId, useRef } from "react";
import { X } from "lucide-react";
import { Button } from "./button";

export interface DialogProps {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  children?: React.ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  onConfirm?: () => void;
  confirmVariant?: "primary" | "danger";
  loading?: boolean;
}

export const Dialog: React.FC<DialogProps> = ({
  open,
  onClose,
  title,
  description,
  children,
  confirmLabel,
  cancelLabel = "Cancel",
  onConfirm,
  confirmVariant = "primary",
  loading = false,
}) => {
  const dialogRef = useRef<HTMLDivElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const wasOpenRef = useRef(false);
  const titleId = useId();
  const descId = useId();

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && open) {
        onClose();
      }
    };
    if (open) {
      if (!wasOpenRef.current) {
        previousFocusRef.current =
          document.activeElement instanceof HTMLElement ? document.activeElement : null;
      }
      wasOpenRef.current = true;
      document.body.style.overflow = "hidden";
      window.addEventListener("keydown", handleKeyDown);
      requestAnimationFrame(() => {
        const container = dialogRef.current;
        if (!container) return;
        const focusable = container.querySelector<HTMLElement>(
          'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
        );
        (focusable ?? container).focus();
      });
    } else {
      document.body.style.overflow = "";
      if (wasOpenRef.current) {
        wasOpenRef.current = false;
        previousFocusRef.current?.focus();
        previousFocusRef.current = null;
      }
    }
    return () => {
      document.body.style.overflow = "";
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      aria-describedby={description ? descId : undefined}
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40 animate-in fade-in duration-100"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={dialogRef}
        tabIndex={-1}
        className="w-full max-w-md rounded-[8px] border border-border bg-surface text-text p-5 space-y-4 shadow-xl focus:outline-none"
      >
        <div className="flex items-start justify-between gap-3">
          <div>
            <h3 id={titleId} className="text-base font-semibold leading-snug text-text">
              {title}
            </h3>
            {description ? (
              <p id={descId} className="text-xs text-text-muted mt-1 leading-normal">
                {description}
              </p>
            ) : null}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close dialog"
            className="text-text-subtle hover:text-text p-1 rounded hover:bg-surface-hover transition-colors"
          >
            <X className="w-4 h-4" strokeWidth={1.5} />
          </button>
        </div>

        {children ? <div className="text-sm">{children}</div> : null}

        {onConfirm || confirmLabel ? (
          <div className="flex items-center justify-end gap-2.5 pt-2 border-t border-border/50">
            <Button variant="secondary" size="md" onClick={onClose} disabled={loading}>
              {cancelLabel}
            </Button>
            {onConfirm && confirmLabel ? (
              <Button
                variant={confirmVariant}
                size="md"
                onClick={onConfirm}
                loading={loading}
              >
                {confirmLabel}
              </Button>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
};

Dialog.displayName = "Dialog";
