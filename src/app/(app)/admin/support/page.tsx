import { requireRole } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { t } from "@/lib/i18n";
import { rands } from "@/lib/money";
import { dateTime } from "@/lib/format";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, Thead, Tbody, Tr, Th, Td } from "@/components/ui/table";
import { StatusBadge } from "@/components/ui/badge";
import { AllClear } from "@/components/ui/empty-state";
import { PageInfoButton } from "@/components/ui/page-info-button";

/**
 * Support cases, as Rapid Rise sees them.
 *
 * ── What this screen is and is not ───────────────────────────────────────────
 * Tickets are WORKED in the RapidRise OS support dashboard, which is where the
 * conversation, the replies and the resolution live. `20260912170000` posts every case
 * there as it opens.
 *
 * This page is deliberately READ-ONLY and deliberately exists anyway, for one reason: the
 * outbound post can fail, the endpoint can be unset, and the dispute that arrived while
 * the integration was down is precisely the one that matters. A record nobody can see is
 * the same as no record, so the cases are visible here whatever the integration is doing.
 *
 * ── Why the deadline is the first column that matters ────────────────────────
 * A card dispute gives roughly 48 BUSINESS HOURS before Paystack settles it on our behalf
 * and takes the money out of a payout. Everything else on a ticket can wait; that cannot.
 * Overdue and due-soon are therefore states with their own words, not a date somebody has
 * to compare against today.
 *
 * Rapid Rise only — a case carries another farm's billing detail and, for a dispute, a
 * bank's claim about a person. `support_tickets_sel` enforces that in RLS; `requireRole`
 * here only spares a farm owner a screen that would be empty anyway.
 */
export const dynamic = "force-dynamic";

type TicketRow = {
  id: string;
  kind: string;
  status: string;
  subject: string;
  farm_id: string | null;
  external_ref: string | null;
  due_at: string | null;
  escalated_at: string | null;
  opened_at: string;
  resolved_at: string | null;
  evidence: Record<string, unknown> | null;
};

/** The three facts a person wants before opening the case itself. */
function summarise(evidence: Record<string, unknown> | null): {
  farm: string | null;
  owner: string | null;
  amount: string | null;
} {
  const e = evidence ?? {};
  const farm = (e.farm ?? null) as { name?: string } | null;
  const owner = (e.owner ?? null) as { name?: string; email?: string } | null;
  const invoice = (e.invoice ?? null) as { total_incl_cents?: number; ref?: string } | null;
  return {
    farm: farm?.name ?? null,
    owner: owner?.email ?? owner?.name ?? null,
    amount:
      invoice?.total_incl_cents != null
        ? `${rands(invoice.total_incl_cents)}${invoice.ref ? ` · ${invoice.ref}` : ""}`
        : null,
  };
}

export default async function AdminSupportPage() {
  const profile = await requireRole(["rr_admin"]);
  const locale = profile.lang;

  const supabase = await createClient();
  const { data } = await supabase
    .from("support_tickets")
    .select(
      "id, kind, status, subject, farm_id, external_ref, due_at, escalated_at, opened_at, resolved_at, evidence",
    )
    // Open cases first, then by deadline — a case with a clock outranks one without.
    .order("resolved_at", { ascending: true, nullsFirst: true })
    .order("due_at", { ascending: true, nullsFirst: false })
    .order("opened_at", { ascending: false })
    .limit(100);

  const tickets = (data as TicketRow[] | null) ?? [];
  const open = tickets.filter((x) => x.status === "open" || x.status === "waiting");
  const now = Date.now();

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <div className="min-w-0">
          <h1 className="text-2xl font-bold tracking-tight text-ink">
            {t("adminSupport.title", locale)}
          </h1>
          <p className="text-sm text-sand-600">{t("adminSupport.lead", locale)}</p>
        </div>
        <span className="ml-auto">
          <PageInfoButton infoKey="adminSupport" locale={locale} />
        </span>
      </div>

      <Card flush>
        <div className="p-4 pb-0 sm:p-5 sm:pb-0">
          <CardHeader>
            <CardTitle>{t("adminSupport.openTitle", locale)}</CardTitle>
          </CardHeader>
          <p className="text-sm text-sand-600">{t("adminSupport.whereWorked", locale)}</p>
        </div>

        {tickets.length === 0 ? (
          <div className="p-4 sm:p-5">
            <AllClear
              title={t("adminSupport.emptyTitle", locale)}
              hint={t("adminSupport.emptyBody", locale)}
            />
          </div>
        ) : (
          <div className="mt-3">
            <Table>
              <Thead>
                <Tr>
                  <Th>{t("adminSupport.colCase", locale)}</Th>
                  <Th>{t("adminSupport.colFarm", locale)}</Th>
                  <Th>{t("adminSupport.colOpened", locale)}</Th>
                  <Th>{t("adminSupport.colDue", locale)}</Th>
                  <Th>{t("adminSupport.colState", locale)}</Th>
                </Tr>
              </Thead>
              <Tbody>
                {tickets.map((ticket) => {
                  const s = summarise(ticket.evidence);
                  const settled = ticket.status === "resolved" || ticket.status === "closed";
                  const hoursLeft =
                    ticket.due_at != null
                      ? (new Date(ticket.due_at).getTime() - now) / 3_600_000
                      : null;
                  const overdue = !settled && hoursLeft != null && hoursLeft < 0;
                  const soon = !settled && hoursLeft != null && hoursLeft >= 0 && hoursLeft <= 12;

                  return (
                    <Tr key={ticket.id}>
                      <Td>
                        <span className="block font-medium text-sand-900">{ticket.subject}</span>
                        <span className="block text-xs text-sand-500">
                          {t(`adminSupport.kind.${ticket.kind}`, locale)}
                          {ticket.external_ref ? ` · ${ticket.external_ref}` : ""}
                        </span>
                      </Td>
                      <Td>
                        <span className="block text-sand-900">{s.farm ?? "—"}</span>
                        {s.owner ? (
                          <span className="block text-xs text-sand-500">{s.owner}</span>
                        ) : null}
                        {s.amount ? (
                          <span className="block text-xs tabular-nums text-sand-600">{s.amount}</span>
                        ) : null}
                      </Td>
                      <Td className="whitespace-nowrap text-sand-600">
                        {dateTime(ticket.opened_at, locale)}
                      </Td>
                      <Td className="whitespace-nowrap">
                        {ticket.due_at ? (
                          <>
                            <span className="block text-sand-700">
                              {dateTime(ticket.due_at, locale)}
                            </span>
                            {overdue ? (
                              <span className="block text-xs font-medium text-status-bad">
                                {t("adminSupport.overdue", locale)}
                              </span>
                            ) : soon ? (
                              <span className="block text-xs font-medium text-status-warn">
                                {t("adminSupport.dueSoon", locale).replace(
                                  "{hours}",
                                  String(Math.max(0, Math.round(hoursLeft as number))),
                                )}
                              </span>
                            ) : null}
                          </>
                        ) : (
                          <span className="text-sm text-sand-500">—</span>
                        )}
                      </Td>
                      <Td>
                        <StatusBadge
                          label={t(`adminSupport.status.${ticket.status}`, locale)}
                          tone={settled ? "ok" : overdue ? "danger" : soon ? "warning" : "info"}
                          shape={settled ? "check" : overdue ? "square" : soon ? "triangle" : "clock"}
                        />
                      </Td>
                    </Tr>
                  );
                })}
              </Tbody>
            </Table>
          </div>
        )}
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t("adminSupport.policyTitle", locale)}</CardTitle>
        </CardHeader>
        {/* The policy in words, on the screen where somebody is about to act on it. The
            two ordinary ways a farm pays less are already automatic and involve no refund;
            what reaches this page is the genuinely individual case. */}
        <ul className="flex list-disc flex-col gap-2 pl-5 text-sm leading-relaxed text-sand-700">
          <li>{t("adminSupport.policyDowngrade", locale)}</li>
          <li>{t("adminSupport.policyCancel", locale)}</li>
          <li>{t("adminSupport.policyRefund", locale)}</li>
          <li>{t("adminSupport.policyDispute", locale)}</li>
        </ul>
      </Card>

      {open.length > 0 ? (
        <p className="text-sm text-sand-600">
          {t("adminSupport.openCount", locale).replace("{n}", String(open.length))}
        </p>
      ) : null}
    </div>
  );
}
