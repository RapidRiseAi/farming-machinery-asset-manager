import type { Lang } from "@/lib/i18n";
import {
  MachineFieldsForm,
  type MachineFieldDefaults,
  type MachineFieldOperator,
} from "@/components/machine-fields-form";

export type OperatorOption = MachineFieldOperator;

/**
 * Shared machine input fields for the create page and the Edit dialog.
 *
 * Server-side on purpose. The form itself is a client component (the type drives the
 * meter), and a client component's props are serialised into the page. A caller hands
 * this the whole machine row, so only the fields the form edits are picked out here;
 * the rest of the row never travels to the browser.
 *
 * `costCentres`, `departments` and `locations` are the values already in use on the
 * farm, offered as suggestions so the list filters do not split on spelling.
 */
export function MachineFields({
  machine,
  operators,
  locale = "en",
  costCentres,
  departments,
  locations,
  financialsLoaded = false,
}: {
  machine?: MachineFieldDefaults;
  operators?: OperatorOption[];
  locale?: Lang;
  costCentres?: string[];
  departments?: string[];
  locations?: string[];
  /**
   * The purchase price and supplier were read for this form (`machine_financials`). Only
   * then does saving write them back: a failed read showed blanks, and saving those used
   * to wipe the price and withdraw its cost entry.
   */
  financialsLoaded?: boolean;
}) {
  const picked: MachineFieldDefaults | undefined = machine
    ? {
        name: machine.name,
        type: machine.type,
        make: machine.make,
        model: machine.model,
        year: machine.year,
        serial_no: machine.serial_no,
        reg_no: machine.reg_no,
        meter_type: machine.meter_type,
        current_reading: machine.current_reading,
        purchase_date: machine.purchase_date,
        purchase_price_cents: machine.purchase_price_cents,
        supplier: machine.supplier,
        warranty_expiry_date: machine.warranty_expiry_date,
        warranty_expiry_hours: machine.warranty_expiry_hours,
        assigned_operator_id: machine.assigned_operator_id,
        location: machine.location,
        cost_centre: machine.cost_centre,
        department: machine.department,
        notes: machine.notes,
      }
    : undefined;
  return (
    <>
    {machine && financialsLoaded ? <input type="hidden" name="financials_loaded" value="1" /> : null}
    <MachineFieldsForm
      machine={picked}
      operators={operators?.map((o) => ({ id: o.id, name: o.name }))}
      locale={locale}
      costCentres={costCentres}
      departments={departments}
      locations={locations}
    />
    </>
  );
}
