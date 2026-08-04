"use client";

import { useMemo, useState } from "react";
import { t, type Locale } from "@/lib/i18n";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/select";
import { SubmitButton } from "@/components/ui/submit-button";
import { Badge } from "@/components/ui/badge";
import { Table, Thead, Tbody, Tr, Th, Td } from "@/components/ui/table";
import {
  validateCsv, templateCsv, MAX_IMPORT_ROWS, IMPORT_COLUMNS, SKIP_COLUMN,
  guessMapping, applyMapping, readHeaders, parseCsv, countDataRows, type ParseResult,
} from "./csv";
import { importMachines } from "../actions";

export function ImportClient({ locale }: { locale: Locale }) {
  const [raw, setRaw] = useState("");
  const [headers, setHeaders] = useState<string[]>([]);
  const [sample, setSample] = useState<string[]>([]);
  const [mapping, setMapping] = useState<string[]>([]);
  const [fileName, setFileName] = useState<string | null>(null);

  /*
    Column mapping happens here, in the browser, and the CANONICAL sheet is what gets
    validated and posted — so `validateCsv` and `importMachines` still see exactly the
    shape they always did. Headers used to be matched against a fixed set, so a real
    farm's spreadsheet (Afrikaans headings, a different order, an extra column the
    office added) failed wholesale.
  */
  const canonical = useMemo(
    () => (raw && mapping.length ? applyMapping(raw, mapping) : ""),
    [raw, mapping],
  );
  const result: ParseResult | null = useMemo(
    () => (canonical ? validateCsv(canonical) : null),
    [canonical],
  );
  const dataRows = useMemo(() => (raw ? countDataRows(raw) : 0), [raw]);
  const mappedName = mapping.includes("name");
  const unmatched = mapping.filter((m) => m === SKIP_COLUMN).length;

  const download = () => {
    const blob = new Blob([templateCsv()], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "farmgear-machines-template.csv";
    a.click();
    URL.revokeObjectURL(url);
  };

  const onFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const text = await file.text();
    const found = readHeaders(text);
    const grid = parseCsv(text);
    setFileName(file.name);
    setRaw(text);
    setHeaders(found);
    setSample(grid[1] ?? []);
    setMapping(guessMapping(found));
  };

  const setColumn = (i: number, col: string) =>
    setMapping((m) => {
      const next = [...m];
      // A canonical column can only come from one source column — picking it here
      // releases it wherever it was.
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

  const tooMany = result && result.rows.length > MAX_IMPORT_ROWS;

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <p className="text-sm text-sand-600">{t("machines.importIntro", locale)}</p>
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <Button type="button" variant="secondary" onClick={download}>
            {t("machines.downloadTemplate", locale)}
          </Button>
          <label className="focus-ring inline-flex cursor-pointer items-center gap-2 rounded-lg border border-dashed border-sand-300 px-4 py-2.5 text-sm font-medium text-sand-700 hover:bg-sand-50">
            {t("machines.chooseFile", locale)}
            <input type="file" accept=".csv,text/csv" className="sr-only" onChange={onFile} />
          </label>
          {fileName ? <span className="text-sm text-sand-500">{fileName}</span> : null}
        </div>
      </Card>

      {/* Step: your columns, matched to ours. */}
      {headers.length > 0 ? (
        <Card>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h2 className="font-semibold text-sand-900">{t("machines.mapTitle", locale)}</h2>
              <p className="mt-0.5 text-sm text-sand-500">{t("machines.mapHint", locale)}</p>
              <p className="mt-1 text-sm text-sand-500">
                {t("machines.mapFileSummary", locale)
                  .replace("{file}", fileName ?? "")
                  .replace("{n}", String(dataRows))}
              </p>
            </div>
            <Button type="button" variant="ghost" onClick={reset}>
              {t("machines.useDifferentFile", locale)}
            </Button>
          </div>

          {!mappedName ? (
            <p className="mt-3 rounded-lg bg-amber-50 px-3 py-2.5 text-sm font-medium text-status-due" role="alert">
              {t("machines.mapNoName", locale)}
            </p>
          ) : null}

          <ul className="mt-4 flex flex-col divide-y divide-sand-100">
            {headers.map((h, i) => (
              <li key={`${h}-${i}`} className="flex flex-wrap items-end gap-3 py-3">
                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium text-sand-900">{h}</p>
                  <p className="truncate text-sm text-sand-500">
                    {sample[i]?.trim() ? sample[i] : <span className="text-sand-300">—</span>}
                  </p>
                </div>
                <label className="w-full sm:w-56">
                  <span className="sr-only">
                    {t("machines.mapOurColumn", locale)} — {h}
                  </span>
                  <Select value={mapping[i] ?? SKIP_COLUMN} onChange={(e) => setColumn(i, e.target.value)}>
                    <option value={SKIP_COLUMN}>{t("machines.mapLeaveOut", locale)}</option>
                    {IMPORT_COLUMNS.map((c) => (
                      <option key={c} value={c}>
                        {t(`machines.${c === "serial_no" ? "serialNo" : c === "reg_no" ? "regNo" : c === "meter_type" ? "meterType" : c === "current_reading" ? "reading" : c}`, locale)}
                      </option>
                    ))}
                  </Select>
                </label>
              </li>
            ))}
          </ul>

          {unmatched > 0 ? (
            <p className="mt-2 text-sm text-sand-500">
              {t("machines.mapUnmatched", locale).replace("{n}", String(unmatched))}
            </p>
          ) : null}
        </Card>
      ) : null}

      {result && result.headerError ? (
        <div
          className="rounded-xl border border-red-200 bg-red-50 px-4 py-3.5 text-sm text-red-800"
          role="alert"
        >
          <p className="text-base font-semibold text-red-900">
            {result.headerError === "empty"
              ? t("machines.err.headerEmptyTitle", locale)
              : t("machines.err.headerNoNameTitle", locale)}
          </p>
          <p className="mt-1 leading-relaxed">
            {result.headerError === "empty"
              ? t("machines.err.headerEmptyBody", locale)
              : t("machines.err.headerNoNameBody", locale)}
          </p>
          {result.headerError === "missing_name_column" && result.headerFound.length > 0 ? (
            <p className="mt-2 leading-relaxed">
              {t("machines.err.headerFound", locale).replace(
                "{cols}",
                result.headerFound.join(", "),
              )}
            </p>
          ) : null}
          <p className="mt-2 leading-relaxed">
            {result.headerError === "empty"
              ? t("machines.err.headerEmptyFix", locale)
              : t("machines.err.headerNoNameFix", locale)}
          </p>
        </div>
      ) : null}

      {result && !result.headerError ? (
        <Card flush>
          <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-3">
            <h2 className="font-semibold text-sand-900">{t("machines.previewTitle", locale)}</h2>
            <span className="flex items-center gap-2 text-sm">
              <Badge tone="ok">{t("machines.rowsValid", locale).replace("{n}", String(result.validCount))}</Badge>
              {result.invalidCount > 0 ? (
                <Badge tone="danger">{t("machines.rowsInvalid", locale).replace("{n}", String(result.invalidCount))}</Badge>
              ) : null}
            </span>
          </div>
          <Table>
            <Thead>
              <Tr>
                <Th>{t("machines.rowNo", locale)}</Th>
                <Th>{t("machines.name", locale)}</Th>
                <Th>{t("machines.type", locale)}</Th>
                <Th>{t("machines.result", locale)}</Th>
              </Tr>
            </Thead>
            <Tbody>
              {result.rows.map((r) => (
                <Tr key={r.line}>
                  <Td className="tabular-nums text-sand-500">{r.line}</Td>
                  <Td className="font-medium">{r.cells.name || <span className="text-sand-300">—</span>}</Td>
                  <Td className="text-sand-600">{r.cells.type || "—"}</Td>
                  <Td>
                    {r.valid ? (
                      <span className="flex flex-wrap items-center gap-1">
                        <Badge tone="ok">{t("machines.willImport", locale)}</Badge>
                        {r.warnings.map((w) => (
                          <Badge key={w} tone="warning">{t(`machines.err.${w}`, locale)}</Badge>
                        ))}
                      </span>
                    ) : (
                      <span className="flex flex-wrap items-center gap-1">
                        {r.errors.map((er) => (
                          <Badge key={er} tone="danger">{t(`machines.err.${er}`, locale)}</Badge>
                        ))}
                      </span>
                    )}
                  </Td>
                </Tr>
              ))}
            </Tbody>
          </Table>
        </Card>
      ) : null}

      {result && !result.headerError ? (
        <form action={importMachines} className="flex flex-col gap-2">
          <input type="hidden" name="csv" value={canonical} />
          {tooMany ? (
            <p className="text-sm text-status-overdue">
              {t("machines.tooManyRows", locale).replace("{n}", String(MAX_IMPORT_ROWS))}
            </p>
          ) : null}
          <SubmitButton variant="primary" disabled={result.validCount === 0 || !!tooMany}>
            {result.validCount > 0
              ? t("machines.importValid", locale).replace("{n}", String(result.validCount))
              : t("machines.nothingValid", locale)}
          </SubmitButton>
        </form>
      ) : null}
    </div>
  );
}
