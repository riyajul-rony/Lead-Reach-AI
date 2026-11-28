"use client";

import React, { useRef } from "react";

export interface TabItem {
  id: string;
  label: string;
  count?: number;
  icon?: React.ReactNode;
}

export interface TabsProps {
  items: TabItem[];
  activeId: string;
  onChange: (id: string) => void;
  className?: string;
}

export const Tabs: React.FC<TabsProps> = ({ items, activeId, onChange, className = "" }) => {
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLButtonElement>, index: number) => {
    if (items.length === 0) return;
    let nextIndex: number | null = null;
    if (e.key === "ArrowRight") {
      nextIndex = (index + 1) % items.length;
    } else if (e.key === "ArrowLeft") {
      nextIndex = (index - 1 + items.length) % items.length;
    } else if (e.key === "Home") {
      nextIndex = 0;
    } else if (e.key === "End") {
      nextIndex = items.length - 1;
    }
    if (nextIndex !== null) {
      e.preventDefault();
      const nextTab = items[nextIndex];
      onChange(nextTab.id);
      tabRefs.current[nextIndex]?.focus();
    }
  };

  return (
    <div
      role="tablist"
      aria-orientation="horizontal"
      className={`flex items-center gap-1 border-b border-border overflow-x-auto no-scrollbar ${className}`}
    >
      {items.map((tab, idx) => {
        const isActive = tab.id === activeId;
        return (
          <button
            key={tab.id}
            ref={(el) => {
              tabRefs.current[idx] = el;
            }}
            type="button"
            role="tab"
            aria-selected={isActive}
            tabIndex={isActive ? 0 : -1}
            onClick={() => onChange(tab.id)}
            onKeyDown={(e) => handleKeyDown(e, idx)}
            className={`relative flex items-center gap-2 px-3 py-2 text-sm font-medium transition-colors whitespace-nowrap cursor-pointer select-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring ${
              isActive
                ? "text-text"
                : "text-text-muted hover:text-text hover:bg-surface-hover/50 rounded-t-[4px]"
            }`}
          >
            {tab.icon ? <span className="shrink-0">{tab.icon}</span> : null}
            <span>{tab.label}</span>
            {typeof tab.count === "number" ? (
              <span
                className={`text-[11px] px-1.5 py-0.2 rounded-full font-mono ${
                  isActive ? "bg-primary text-primary-text" : "bg-bg-subtle text-text-subtle"
                }`}
              >
                {tab.count}
              </span>
            ) : null}
            {isActive ? (
              <span className="absolute bottom-0 left-0 right-0 h-0.5 bg-primary rounded-t" />
            ) : null}
          </button>
        );
      })}
    </div>
  );
};

Tabs.displayName = "Tabs";
