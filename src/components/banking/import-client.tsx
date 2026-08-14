"use client";

import { useMemo, useState } from "react";
import { t, type Lang } from "@/lib/i18n";
import { rands } from "@/lib/money";
import { shortDate } from "@/lib/format";
import {
  BANK_COLUMNS, SKIP_COLUMN, MAX_STATEMENT_ROWS,
  guessBankMapping, applyBankMapping, parseStatement, readHeaders, readSampleRow,
  type StatementParse,
} from "@/lib/banking";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/select";
import { TextField } from "@/components/ui/field";
import { SubmitButton } from "@/components/ui/submit-button";
import { Badge } from "@/components/ui/badge";
import { Flash } from "@/components/ui/flash";
import { Table, Thead, Tbody, Tr, Th, Td } from "@/components/ui/table";
import { importBankStatement } from "@/app/(app)/banking/actions";

const PREVIEW_ROWS = 20;

/**
 * Loading a statement, in the order a person does it: choose the file, check that we read
 * the columns the way they meant them, look at what is about to be stored, load it.
 *
 * A client component because the mapping has to be corrected against something the person
 * can see. Showing "Datum → date" next to the actual value `13/08/2026` is the difference
 * between a mapping step that gets checked and one that gets clicked past — and a wrong
 * amount column here becomes a wrong payment against a real invoice.
 *
 * The MAPPED sheet is what gets posted, never the bank's own. The server therefore parses
 * one canonical shape and stays ignorant of which bank produced the file, which is the same
 * division the machines importer settled on.
 */
export function BankImportClient({ locale }: { locale: Lang }) {
  const [raw, setRaw] = useState("");
  const [headers, setHeaders] = useState<string[]>([]);
  const [sample, setSample] = useState<string[]>([]);
  const [mapping, setMapping] = useState<string[]>([]);
  const [fileName, setFileName] = useState<string | null>(null);

  const canonical = useMemo(
    () => (raw && mapping.length ? applyBankMapping(raw, mapping) : ""),
    [raw, mapping],
  );
  const result: StatementParse | null = useMemo(
    () => (canonical ? parseStatement(canonical) : null),
    [canonical],
  );

  const hasDate = mapping.includes("date");
  const hasAmount = mapping.includes("amount") || mapping.includes("money_in") || mapping.includes("money_out");
  const tooMany = !!result && result.validCount > MAX_STATEMENT_ROWS;

  const onFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const text = await file.text();
    const found = readHeaders(text);
    setFileName(file.name);
    setRaw(text);
    setHeaders(found);
    setSample(readSampleRow(text));
    setMapping(guessBankMapping(found));
  };

  const setColumn = (i: number, col: string) =>
    setMapping((m) => {
      const next = [...m];
      // One of our columns can only come from one of theirs — picking it here releases it
      // wherever it was, so the person never has to undo a guess before making a choice.
      if (col !== SKIP_COLUMN) {
        for (let j = 0; j < next.length; j++) if (j !== i && next[j] === col) next[j] = SKIP_COLUMN;
      }
      next[i] = col;
      return next;
    });

  const reset = () => {
    setRaw("");
    setHeaders([]);
    setSample([]);
    setMapping([]);
    setFileName(null);
  };

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <p className="text-sm text-sand-600">{t("bank.importIntro", locale)}</p>
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <label className="focus-ring inline-flex min-h-[48px] cursor-pointer items-center gap-2 rounded-lg border border-dashed border-sand-300 px-4 py-2.5 text-sm font-medium text-sand-700 hover:bg-sand-50">
            {t("bank.chooseFile", locale)}
            <input type="file" accept=".csv,text/csv" className="sr-only" onChange={onFile} />
          </label>
          {fileName ? <span className="text-sm text-sand-500">{fileName}</span> : null}
        </div>
      </Card>

      {headers.length > 0 ? (
        <Card>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h2 className="font-semibold text-sand-900">{t("bank.mapTitle", locale)}</h2>
              <p className="mt-0.5 text-sm text-sand-500">{t("bank.mapHint", locale)}</p>
            </div>
            <Button type="button" variant="ghost" onClick={reset}>
              {t("bank.useDifferentFile", locale)}
            </Button>
          </div>

          {!hasDate ? <Flash tone="warning" message={t("bank.mapNoDate", locale)} className="mt-3" /> : null}
          {!hasAmount ? <Flash tone="warning" message={t("bank.mapNoAmount", locale)} className="mt-3" /> : null}

          <ul className="mt-4 flex flex-col divide-y divide-sand-100">
            {headers.map((h, i) => (
              <li key={`${h}-${i}`} className="flex flex-wrap items-end gap-3 py-3">
                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium text-sand-900">{h}</p>
                  <p className="truncate text-sm text-sand-500">
                    {sample[i]?.trim() ? sample[i] : <span className="text-sand-300">&mdash;</span>}
                  </p>
                </div>
                <label className="w-full sm:w-60">
                  <span className="sr-only">
                    {t("bank.mapOurColumn", locale)} &mdash; {h}
                  </span>
                  <Select value={mapping[i] ?? SKIP_COLUMN} onChange={(e) => setColumn(i, e.target.value)}>
                    <option value={SKIP_COLUMN}>{t("bank.mapLeaveOut", locale)}</option>
                    {BANK_COLUMNS.map((c) => (
                      <option key={c} value={c}>
                        {t(`bank.col.${c}`, locale)}
                      </option>
                    ))}
                  </Select>
                </label>
              </li>
            ))}
          </ul>
          <p className="mt-2 text-sm text-sand-500">{t("bank.mapBalanceNote", locale)}</p>
        </Card>
      ) : null}

      {result && result.headerError ? (
        <Flash tone="error" message={t(`bank.err.${result.headerError}`, locale)} />
      ) : null}

      {result && !result.headerError ? (
        <Card flush>
          <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-3">
            <h2 className="font-semibold text-sand-900">{t("bank.previewTitle", locale)}</h2>
            <span className="flex flex-wrap items-center gap-2 text-sm">
              <Badge tone="ok">
                {t("bank.rowsReady", locale).replace("{n}", String(result.validCount))}
              </Badge>
              {result.invalidCount > 0 ? (
                <Badge tone="danger">
                  {t("bank.rowsSkipped", locale).replace("{n}", String(result.invalidCount))}
                </Badge>
              ) : null}
            </span>
          </div>

          {/* The two totals and the date range exist so the person can hold the preview up
              against the statement's own footer before anything is stored. It is the only
              check available that does not require trusting our parser. */}
          <div className="grid gap-2 border-t border-sand-100 px-4 py-3 text-sm sm:grid-cols-3">
            <p className="text-sand-600">
              {t("bank.totalIn", locale)}{" "}
              <span className="font-medium tabular-nums text-status-ok">{rands(result.inCents)}</span>
            </p>
            <p className="text-sand-600">
              {t("bank.totalOut", locale)}{" "}
              <span className="font-medium tabular-nums text-status-overdue">{rands(result.outCents)}</span>
            </p>
            <p className="text-sand-600">
              {result.firstDate && result.lastDate
                ? `${shortDate(result.firstDate, locale)} – ${shortDate(result.lastDate, locale)}`
                : "—"}
            </p>
          </div>

          <Table>
            <Thead>
              <Tr>
                <Th>{t("bank.colRow", locale)}</Th>
                <Th>{t("bank.col.date", locale)}</Th>
                <Th>{t("bank.col.description", locale)}</Th>
                <Th>{t("bank.col.reference", locale)}</Th>
                <Th>{t("bank.col.amount", locale)}</Th>
                <Th>{t("bank.colResult", locale)}</Th>
              </Tr>
            </Thead>
            <Tbody>
              {result.rows.slice(0, PREVIEW_ROWS).map((r) => (
                <Tr key={r.line}>
                  <Td className="tabular-nums text-sand-500">{r.line}</Td>
                  <Td className="whitespace-nowrap">
                    {r.row ? shortDate(r.row.txn_date, locale) : r.cells.date || "—"}
                  </Td>
                  <Td className="text-sand-600">{r.cells.description || "—"}</Td>
                  <Td className="font-mono text-xs text-sand-500">{r.cells.reference || "—"}</Td>
                  <Td className="tabular-nums">
                    {r.row ? (
                      <span className={r.row.amount_cents > 0 ? "text-status-ok" : "text-status-overdue"}>
                        {rands(r.row.amount_cents)}
                      </span>
                    ) : (
                      "—"
                    )}
                  </Td>
                  <Td>
                    {r.valid ? (
                      <Badge tone="ok">{t("bank.willImport", locale)}</Badge>
                    ) : (
                      <span className="flex flex-wrap items-center gap-1">
                        {r.errors.map((er) => (
                          <Badge key={er} tone="danger">
                            {t(`bank.err.${er}`, locale)}
                          </Badge>
                        ))}
                      </span>
                    )}
                  </Td>
                </Tr>
              ))}
            </Tbody>
          </Table>
          {result.rows.length > PREVIEW_ROWS ? (
            <p className="px-4 py-3 text-sm text-sand-500">
              {t("bank.previewMore", locale).replace("{n}", String(result.rows.length - PREVIEW_ROWS))}
            </p>
          ) : null}
        </Card>
      ) : null}

      {result && !result.headerError ? (
        <form action={importBankStatement} className="flex flex-col gap-3">
          <input type="hidden" name="csv" value={canonical} />
          <input type="hidden" name="file_name" value={fileName ?? ""} />
          <Card>
            <TextField
              name="account_label"
              label={t("bank.accountLabel", locale)}
              hint={t("bank.accountLabelHint", locale)}
              defaultValue={fileName ?? ""}
              maxLength={80}
            />
          </Card>
          {tooMany ? (
            <Flash
              tone="error"
              message={t("bank.err.too_many", locale).replace("{n}", String(MAX_STATEMENT_ROWS))}
            />
          ) : null}
          <SubmitButton variant="primary" disabled={result.validCount === 0 || tooMany}>
            {result.validCount > 0
              ? t("bank.importAction", locale).replace("{n}", String(result.validCount))
              : t("bank.nothingToImport", locale)}
          </SubmitButton>
          <p className="text-sm text-sand-500">{t("bank.reimportSafe", locale)}</p>
        </form>
      ) : null}
    </div>
  );
}
