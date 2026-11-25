import { describe, it, expect } from "vitest";
import { resolveSpintax, renderEmailTemplate } from "./template-renderer";
import { buildEmailMultipartBodies } from "./sending-engine";

describe("Phase 3 Step 1: Spintax Support", () => {
  it("resolves basic {option1|option2|option3} spintax with deterministic RNG", () => {
    const template = "{Hi|Hello|Hey} team, {quick question|short note}!";
    expect(resolveSpintax(template, () => 0.0)).toBe("Hi team, quick question!");
    expect(resolveSpintax(template, () => 0.49)).toBe("Hello team, quick question!");
    expect(resolveSpintax(template, () => 0.99)).toBe("Hey team, short note!");
  });

  it("resolves nested spintax from innermost to outermost cleanly", () => {
    const template = "{Hi {friend|partner}|Hello {team|{boss|founder}}}";
    // Always pick first option (index 0)
    expect(resolveSpintax(template, () => 0.0)).toBe("Hi friend");
    // Always pick last option
    expect(resolveSpintax(template, () => 0.99)).toBe("Hello founder");
  });

  it("runs resolveSpintax BEFORE renderEmailTemplate so merge tags inside branches work and scraped lead vars containing {...} are never mutated", () => {
    const template =
      "{Hi {{first_name|there}}|Greetings {{first_name|friend}}} from {{company_name|your company}}";

    // Branch 1 chosen, missing first_name -> uses fallback 'there'
    const res1 = renderEmailTemplate(
      template,
      { company_name: "Acme {Widgets|Tools}" },
      undefined,
      () => 0.0
    );
    expect(res1).toBe("Hi there from Acme {Widgets|Tools}");

    // Branch 2 chosen, lead first_name has literal braces -> MUST NOT be spun!
    const res2 = renderEmailTemplate(
      template,
      { first_name: "Sarah {CTO|VP}", company_name: "Cyberdyne" },
      undefined,
      () => 0.99
    );
    expect(res2).toBe("Greetings Sarah {CTO|VP} from Cyberdyne");
  });

  it("never breaks {{unsubscribe_url}} or click-tracking/HTML-escaping when combined with buildEmailMultipartBodies", () => {
    const unsubUrl = "http://localhost:3000/u/unsub_tok_123";
    const template =
      "{Check|View} https://example.com/demo {{first_name|there}} — opt out: {{unsubscribe_url}}";

    const renderedBody = renderEmailTemplate(
      template,
      { first_name: "<script>Bob</script>" },
      unsubUrl,
      () => 0.0
    );
    expect(renderedBody).toBe(
      "Check https://example.com/demo <script>Bob</script> — opt out: http://localhost:3000/u/unsub_tok_123"
    );

    const { text, html } = buildEmailMultipartBodies({
      bodyText: renderedBody,
      legalAddress: "123 Business St",
      unsubscribeUrl: unsubUrl,
      unsubscribeToken: "unsub_tok_123",
      baseUrl: "http://localhost:3000",
      trackingOpen: false,
      trackingClick: true,
    });

    // Plain-text preserves raw resolved spintax & unsubscribe link
    expect(text).toContain("Check https://example.com/demo");
    expect(text).toContain(unsubUrl);
    // HTML escapes lead data and wraps only non-unsubscribe links
    expect(html).toContain("&lt;script&gt;Bob&lt;/script&gt;");
    expect(html).toContain("/api/v1/track/click/");
    expect(html).toContain(`href="${unsubUrl}"`);
  });

  it("gracefully falls back on malformed, unclosed, or non-spintax braces without throwing", () => {
    const malformed = "{Unclosed option1|option2 and {singleBrace} plus } stray";
    expect(resolveSpintax(malformed)).toBe(malformed);

    // Mixed valid + malformed: valid spins, malformed stays intact
    const mixed = "{Hi|Hello} {unclosed|branch";
    expect(resolveSpintax(mixed, () => 0.99)).toBe("Hello {unclosed|branch");
  });
});
