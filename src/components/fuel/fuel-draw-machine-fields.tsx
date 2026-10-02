"use client";

import { useState } from "react";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";

/**
 * The machine and meter pair in "Diesel went out".
 *
 * Client-side for one reason: the hint under the meter box names the LAST reading of
 * whichever machine is chosen, so it has to follow the select. A server-rendered hint
 * for the preselected machine went stale the moment somebody picked another one.
 *
 * There is no blank default. A draw booked to "Whole farm" never reaches consumption
 * per machine, so the farm-level choice is an explicit last option with its own value
 * (`farmValue`), and the empty value is a disabled placeholder the browser refuses.
 */
export type FuelDrawMachine = {
  id: string;
  name: string;
  /** Last known meter reading, for the "lower than last time" check. */
  lastReading: number | null;
  /** Formatted on the server: "Last: 4 512 hours on 12 Sep". */
  lastText: string | null;
  /** False for a machine without a meter: the meter box is hidden for it. */
  metered: boolean;
};

export function FuelDrawMachineFields({
  machines,
  defaultMachineId,
  farmValue,
  labels,
}: {
  machines: FuelDrawMachine[];
  /** "" opens on the placeholder. */
  defaultMachineId: string;
  farmValue: string;
  labels: {
    machine: string;
    placeholder: string;
    farmLevel: string;
    meter: string;
    meterLower: string;
  };
}) {
  const [machineId, setMachineId] = useState(defaultMachineId);
  const [meter, setMeter] = useState("");
  const chosen = machines.find((m) => m.id === machineId) ?? null;
  const showMeter = chosen ? chosen.metered : machineId === "";
  const reading = meter.trim() === "" ? null : Number(meter);
  const lower =
    chosen?.lastReading != null && reading != null && Number.isFinite(reading) && reading < chosen.lastReading;

  return (
    <>
      <Field label={labels.machine} htmlFor="i_machine" required>
        <Select
          id="i_machine"
          name="machine_id"
          required
          value={machineId}
          onChange={(e) => setMachineId(e.target.value)}
        >
          <option value="" disabled>
            {labels.placeholder}
          </option>
          {machines.map((m) => (
            <option key={m.id} value={m.id}>
              {m.name}
            </option>
          ))}
          <option value={farmValue}>{labels.farmLevel}</option>
        </Select>
      </Field>
      {showMeter ? (
        <Field
          label={labels.meter}
          htmlFor="i_meter"
          hint={
            lower ? (
              <span className="font-medium text-status-due">{labels.meterLower}</span>
            ) : (
              (chosen?.lastText ?? undefined)
            )
          }
        >
          <Input
            id="i_meter"
            name="meter_reading"
            type="number"
            inputMode="decimal"
            step="0.1"
            min={0}
            value={meter}
            onChange={(e) => setMeter(e.target.value)}
          />
        </Field>
      ) : null}
    </>
  );
}
