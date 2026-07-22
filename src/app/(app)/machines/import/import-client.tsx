"use client";

import { useState } from "react";
import { t, type Locale } from "@/lib/i18n";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { SubmitButton } from "@/components/ui/submit-button";
import { Badge } from "@/components/ui/badge";
import { Table, Thead, Tbody, Tr, Th, Td } from "@/components/ui/table";
import { validateCsv, templateCsv, MAX_IMPORT_ROWS, type ParseResult } from "./csv";
import { importMachines } from "../actions";

export function ImportClient({ locale }: { locale: Locale }) {
  const [raw, setRaw] = useState("");
  const [result, setResult] = useState<ParseResult | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);

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
    setFileName(file.name);
    const text = await file.text();
    setRaw(text);
    setResult(validateCsv(text));
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

      {result && result.headerError ? (
        <p className="rounded-lg bg-red-50 px-4 py-3 text-sm text-red-700" role="alert">
          {t("machines.err.name_required", locale)} — {t("machines.previewTitle", locale)}
        </p>
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
          <input type="hidden" name="csv" value={raw} />
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
