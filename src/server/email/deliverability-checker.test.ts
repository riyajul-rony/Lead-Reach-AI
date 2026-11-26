import { describe, it, expect, vi, afterEach } from "vitest";
import {
  analyzeDeliverability,
  MISSING_ADDRESS_OR_OPTOUT_WARNING_MESSAGE,
  type DeliverabilityCheckInput,
} from "./deliverability-checker";

const cleanInput: DeliverabilityCheckInput = {
  subject: "Quick question about Q4 pipeline",
  body: "Hi Jordan,\n\nSaw your recent expansion and wanted to connect.\n\nBest,\nAlex\n\n500 Market St, San Francisco, CA 94105\nReply unsubscribe to opt out.",
  stepNo: 1,
  mode: "template",
  trackingOpen: false,
  trackingClick: false,
  businessAddress: "500 Market St, San Francisco, CA 94105",
  senderAccounts: [
    {
      id: "acc-1",
      from_email: "alex@acme.io",
      from_name: "Alex Carter",
      dns_spf_status: "pass",
      dns_dkim_status: "pass",
      dns_dmarc_status: "pass",
      status: "active",
    },
  ],
  recipients: [{ email: "jordan@target.com", name: "Jordan Lee" }],
};

describe("Task 10 — Pre-send Deliverability Checker", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns pass with zero errors and zero warnings for a clean plain-text message without making any network calls", () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const result = analyzeDeliverability(cleanInput);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(result.status).toBe("pass");
    expect(result.canLaunch).toBe(true);
    expect(result.errors).toHaveLength(0);
    expect(result.warnings).toHaveLength(0);
  });

  it("blocks launch (errors) on empty subject/body, broken spintax, unresolved vars, invalid recipients, inactive senders, and DNS failures", () => {
    // 1. Empty subject & body + unresolved var + broken spintax
    const badText = analyzeDeliverability({
      ...cleanInput,
      subject: "",
      body: "Hi {{missing_field}}, {Hello|",
      rawBodyTemplate: "Hi {{missing_field}}, {Hello|",
    });
    expect(badText.canLaunch).toBe(false);
    expect(badText.status).toBe("error");
    const errorCodes = badText.errors.map((e) => e.code);
    expect(errorCodes).toContain("empty_subject");
    expect(errorCodes).toContain("unresolved_variables");
    expect(errorCodes).toContain("malformed_spintax");

    // 2. Empty body in template mode
    const emptyBody = analyzeDeliverability({ ...cleanInput, body: "   " });
    expect(emptyBody.errors.some((e) => e.code === "empty_body")).toBe(true);

    // 3. Invalid or empty recipients
    const badRecipients = analyzeDeliverability({
      ...cleanInput,
      recipients: [{ email: "not-an-email" }],
    });
    expect(badRecipients.errors.some((e) => e.code === "invalid_recipients")).toBe(true);
    const noRecipients = analyzeDeliverability({ ...cleanInput, recipients: [] });
    expect(noRecipients.errors.some((e) => e.code === "no_recipients")).toBe(true);

    // 4. Paused / no active sender
    const pausedSender = analyzeDeliverability({
      ...cleanInput,
      senderAccounts: [{ ...cleanInput.senderAccounts![0], status: "paused_deliverability" }],
    });
    expect(pausedSender.errors.some((e) => e.code === "no_active_sender")).toBe(true);

    // 5. DNS fail -> error
    const dnsFail = analyzeDeliverability({
      ...cleanInput,
      senderAccounts: [{ ...cleanInput.senderAccounts![0], dns_spf_status: "fail" }],
    });
    expect(dnsFail.errors.some((e) => e.code === "dns_authentication_fail")).toBe(true);
  });

  it("warns cleanly (dismissible) for missing/mismatched From Name, Step 1 links, cross-domain/short/long URLs, tracking, spam/caps/length, HTML, and missing postal/opt-out copy", () => {
    const longUrl = `https://bit.ly/promo?campaign=${"x".repeat(80)}`;
    const bodyText = `${Array.from({ length: 260 }, () => "word").join(" ")}\n<p>Check ${longUrl} — 100% FREE GUARANTEED!! LIMITED TIME</p>\nBest,\nSam`;

    const res = analyzeDeliverability({
      subject: "ACT NOW!! URGENT",
      body: bodyText,
      stepNo: 1,
      trackingOpen: true,
      trackingClick: true,
      businessAddress: "",
      senderAccounts: [
        {
          id: "acc-w",
          from_email: "alex@acme.io",
          from_name: "Lead Reach AI",
          dns_spf_status: "unknown",
          dns_dkim_status: "unknown",
          dns_dmarc_status: "unknown",
          status: "active",
        },
      ],
      recipients: [{ email: "lead@example.com" }],
    });

    expect(res.status).toBe("warn");
    expect(res.canLaunch).toBe(true);
    const warnCodes = res.warnings.map((w) => w.code);
    expect(warnCodes).toContain("generic_or_missing_from_name");
    expect(warnCodes).toContain("dns_unverified");
    expect(warnCodes).toContain("step1_links_present");
    expect(warnCodes).toContain("url_shortener");
    expect(warnCodes).toContain("cross_domain_link");
    expect(warnCodes).toContain("long_url");
    expect(warnCodes).toContain("tracking_enabled");
    expect(warnCodes).toContain("missing_address_or_optout");
    expect(warnCodes).toContain("spam_trigger_words");
    expect(warnCodes).toContain("caps_or_exclamations");
    expect(warnCodes).toContain("body_too_long");
    expect(warnCodes).toContain("html_in_body");

    const complianceWarn = res.warnings.find((w) => w.code === "missing_address_or_optout");
    expect(complianceWarn?.message).toBe(MISSING_ADDRESS_OR_OPTOUT_WARNING_MESSAGE);
    expect(complianceWarn?.message).toBe(
      "Your text has no postal address or opt-out line. For US/UK recipients commercial email generally requires both (CAN-SPAM, PECR/GDPR). The List-Unsubscribe header is still sent."
    );
  });

  it("warns specifically when human From Name first word disagrees with body signature name", () => {
    const res = analyzeDeliverability({
      ...cleanInput,
      senderAccounts: [{ ...cleanInput.senderAccounts![0], from_name: "Marcus Rivera" }],
      body: "Hi Jordan,\n\nChecking in briefly.\n\nBest,\nAlex\n\n500 Market St, San Francisco, CA 94105\nReply unsubscribe to opt out.",
    });

    expect(res.warnings.some((w) => w.code === "from_name_signature_mismatch")).toBe(true);
  });
});
