"use client";

import { useState } from "react";
import { Badge } from "@/components/ui/badge";

const CATEGORY_OPTIONS = [
  { value: "interested", label: "Interested" },
  { value: "not_interested", label: "Not Interested" },
  { value: "out_of_office", label: "Out of Office" },
  { value: "bounce", label: "Bounce" },
  { value: "unsubscribe", label: "Unsubscribe (Review)" },
  { value: "other", label: "Other" },
  { value: "uncategorized", label: "Uncategorized" },
] as const;

function getCategoryVariant(cat: string): "success" | "warning" | "danger" | "neutral" | "accent" {
  switch (cat) {
    case "interested":
      return "success";
    case "not_interested":
      return "neutral";
    case "out_of_office":
      return "accent";
    case "bounce":
    case "unsubscribe":
      return "danger";
    default:
      return "warning";
  }
}

function getCategoryLabel(cat: string): string {
  return CATEGORY_OPTIONS.find((o) => o.value === cat)?.label || "Uncategorized";
}

export function ReplyCategoryControls({
  messageId,
  initialCategory,
  source,
}: {
  messageId: string;
  initialCategory?: string | null;
  source?: string | null;
}) {
  const [category, setCategory] = useState<string>(initialCategory || "uncategorized");
  const [saving, setSaving] = useState(false);

  const handleChange = async (nextCat: string) => {
    const previous = category;
    setCategory(nextCat);
    setSaving(true);
    try {
      const res = await fetch(`/api/v1/replies/${messageId}/category`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ category: nextCat }),
      });
      if (!res.ok) {
        setCategory(previous);
      }
    } catch {
      setCategory(previous);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex items-center gap-2 flex-wrap">
      <Badge variant={getCategoryVariant(category)} size="sm" dot>
        {getCategoryLabel(category)}
      </Badge>
      {source === "ai" && (
        <span className="text-[10px] font-mono text-muted uppercase">AI</span>
      )}
      <select
        aria-label="Override reply category"
        value={category}
        disabled={saving}
        onChange={(e) => handleChange(e.target.value)}
        className="text-[11px] rounded-md border border-border bg-bgSubtle text-fg px-2 py-1 focus:outline-hidden focus:border-primary disabled:opacity-60"
      >
        {CATEGORY_OPTIONS.map((opt) => (
          <option key={opt.value} value={opt.value}>
            {opt.label}
          </option>
        ))}
      </select>
    </div>
  );
}
