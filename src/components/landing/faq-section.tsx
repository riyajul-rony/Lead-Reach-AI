"use client";

import { useState } from "react";
import { ChevronDown } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { LANDING_FAQS } from "@/lib/landing-faq";

export function FAQSection() {
  const [openIndex, setOpenIndex] = useState<number | null>(0);

  const toggle = (idx: number) => {
    setOpenIndex(openIndex === idx ? null : idx);
  };

  return (
    <section id="faq" className="px-6 py-20 border-t border-border bg-surface">
      <div className="mx-auto max-w-4xl">
        <div className="text-center mb-12">
          <Badge variant="neutral" className="mb-3">
            Got Questions?
          </Badge>
          <h2 className="text-3xl sm:text-4xl font-bold tracking-tight text-fg">
            Frequently Asked Questions
          </h2>
          <p className="mt-3 text-sm sm:text-base text-muted">
            Clear answers on outreach deliverability, self warm-up, custom tracking domains, and security.
          </p>
        </div>

        <div className="space-y-3">
          {LANDING_FAQS.map((item, idx) => {
            const isOpen = openIndex === idx;
            const buttonId = `faq-trigger-${idx}`;
            const panelId = `faq-panel-${idx}`;
            return (
              <div
                key={item.question}
                className="rounded-xl border border-border bg-bgSubtle transition-colors overflow-hidden"
              >
                <button
                  id={buttonId}
                  type="button"
                  onClick={() => toggle(idx)}
                  className="w-full flex items-center justify-between p-4 sm:p-5 text-left text-sm sm:text-base font-semibold text-fg hover:text-primary transition-colors focus:outline-none"
                  aria-expanded={isOpen}
                  aria-controls={panelId}
                >
                  <span className="pr-4">{item.question}</span>
                  <ChevronDown
                    size={18}
                    className={`shrink-0 text-muted transition-transform duration-200 ${
                      isOpen ? "rotate-180 text-fg" : ""
                    }`}
                  />
                </button>
                <div
                  id={panelId}
                  role="region"
                  aria-labelledby={buttonId}
                  hidden={!isOpen}
                  className={
                    isOpen
                      ? "px-4 pb-5 sm:px-5 sm:pb-5 pt-0 text-xs sm:text-sm text-muted leading-relaxed border-t border-border/50"
                      : "hidden"
                  }
                >
                  <p className="pt-3">{item.answer}</p>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}
