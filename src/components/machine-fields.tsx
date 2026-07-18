import { MACHINE_TYPES, METER_TYPES, TYPE_LABELS, METER_LABELS } from "@/lib/machine-options";

type Defaults = {
  name?: string | null;
  type?: string | null;
  make?: string | null;
  model?: string | null;
  year?: number | null;
  serial_no?: string | null;
  reg_no?: string | null;
  meter_type?: string | null;
  current_reading?: number | null;
};

/** Shared machine input fields for the create + edit forms. */
export function MachineFields({ machine }: { machine?: Defaults }) {
  const m = machine ?? {};
  const input = "rounded border border-gray-300 p-2";
  return (
    <div className="flex flex-col gap-2">
      <input name="name" required defaultValue={m.name ?? ""} placeholder="Name / nickname" className={input} />
      <select name="type" defaultValue={m.type ?? "tractor"} className={input}>
        {MACHINE_TYPES.map((t) => (
          <option key={t} value={t}>
            {TYPE_LABELS[t]}
          </option>
        ))}
      </select>
      <div className="flex gap-2">
        <input name="make" defaultValue={m.make ?? ""} placeholder="Make" className={`${input} flex-1`} />
        <input name="model" defaultValue={m.model ?? ""} placeholder="Model" className={`${input} flex-1`} />
        <input
          name="year"
          type="number"
          inputMode="numeric"
          defaultValue={m.year ?? ""}
          placeholder="Year"
          className={`${input} w-24`}
        />
      </div>
      <div className="flex gap-2">
        <input name="serial_no" defaultValue={m.serial_no ?? ""} placeholder="Serial / VIN" className={`${input} flex-1`} />
        <input name="reg_no" defaultValue={m.reg_no ?? ""} placeholder="Reg. no." className={`${input} flex-1`} />
      </div>
      <div className="flex gap-2">
        <select name="meter_type" defaultValue={m.meter_type ?? "hours"} className={`${input} flex-1`}>
          {METER_TYPES.map((mt) => (
            <option key={mt} value={mt}>
              {METER_LABELS[mt]}
            </option>
          ))}
        </select>
        <input
          name="current_reading"
          type="number"
          inputMode="decimal"
          step="0.1"
          defaultValue={m.current_reading ?? ""}
          placeholder="Current reading"
          className={`${input} flex-1`}
        />
      </div>
    </div>
  );
}
