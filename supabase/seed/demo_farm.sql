-- demo_farm.sql — the sales-demo & training sandbox (Scope §8).
-- Creates one realistic farm ("Weltevrede Boerdery") with 12 machines and real
-- histories: meter readings, service plans, faults (open + resolved), completed
-- job cards with costed lines (one approved/locked), and watch items.
--
-- Idempotent: does nothing if the demo farm already exists. Safe to run against
-- the local test DB or a hosted Supabase project (service role).
--
-- NOTE on users: this inserts rows into auth.users directly so the profile FKs
-- resolve and the demo data is complete. Those demo accounts cannot *log in*
-- (no Auth identity/password) — that's fine for a data sandbox. Create a real
-- login for the demo owner via the invite flow / Auth admin API separately.
--
-- Money is in integer cents, ex-VAT (Scope §6).

do $seed$
declare
  v_farm     uuid := 'aa000000-0000-0000-0000-000000000001';
  v_workshop uuid := 'bb000000-0000-0000-0000-000000000001';
  v_owner    uuid := '10000000-0000-0000-0000-000000000001';
  v_manager  uuid := '10000000-0000-0000-0000-000000000002';
  v_mech     uuid := '10000000-0000-0000-0000-000000000003';
  v_op1      uuid := '10000000-0000-0000-0000-000000000004';
  v_op2      uuid := '10000000-0000-0000-0000-000000000005';
  v_wstaff   uuid := '10000000-0000-0000-0000-000000000006';
begin
  if exists (select 1 from farms where id = v_farm) then
    raise notice 'demo farm already seeded — skipping';
    return;
  end if;

  -- ── Farm (Complete plan, active) — a strong plan so the demo shows every
  --     entitlement-gated surface (dashboard, fuel, advanced reports, AARTO). ──
  insert into farms (id, name, plan, billing_period, status, settings) values
    (v_farm, 'Weltevrede Boerdery', 'complete', 'annual', 'active',
     jsonb_build_object(
       'currency','ZAR','vat_rate_bps',1500,'vat_inclusive_entry',true,
       'default_language','af','due_soon_hours',25,'due_soon_days',14,
       'stale_reading_days',30,'approval_required',true,
       'cost_visible_to_operators',false,'quiet_hours_start',20,'quiet_hours_end',5));

  -- ── External workshop + link (classified contractor, F12a) ─────
  insert into workshops (id, name, contact, kind, phone, whatsapp, email, area) values
    (v_workshop, 'TJ Service & Repairs', 'TJ — 082 555 0134', 'mechanic',
     '+27825550134', '+27825550134', 'tj@tjrepairs.example', 'Bothaville');
  insert into workshop_links (workshop_id, farm_id, status) values
    (v_workshop, v_farm, 'active');

  -- ── Users (auth shell + profiles) ──────────────────────────────
  insert into auth.users (id, email) values
    (v_owner,   'danie@weltevrede.example'),
    (v_manager, 'piet@weltevrede.example'),
    (v_mech,    'johan@weltevrede.example'),
    (v_op1,     'thabo@weltevrede.example'),
    (v_op2,     'sipho@weltevrede.example'),
    (v_wstaff,  'tj@tjservice.example')
  on conflict (id) do nothing;

  insert into users (id, farm_id, workshop_id, role, name, phone, language, whatsapp_opt_in) values
    (v_owner,   v_farm, null, 'owner',    'Oom Danie', '+27825550101', 'af', true),
    (v_manager, v_farm, null, 'manager',  'Piet Botha', '+27825550102', 'af', true),
    (v_mech,    v_farm, null, 'mechanic', 'Johan (werkswinkel)', '+27825550103', 'af', false),
    (v_op1,     v_farm, null, 'operator', 'Thabo', '+27825550104', 'en', false),
    (v_op2,     v_farm, null, 'operator', 'Sipho', '+27825550105', 'en', false),
    (v_wstaff,  null, v_workshop, 'workshop', 'TJ', '+27825550134', 'en', true);

  -- ── Global service templates (RR-seeded library) ───────────────
  insert into service_templates (farm_id, machine_type, name, lines) values
    (null, 'tractor', 'Tractor — standard', '[
       {"task":"Engine oil + filter","interval_hours":250,"interval_months":12},
       {"task":"Hydraulic / transmission service","interval_hours":500,"interval_months":24},
       {"task":"Coolant service","interval_hours":1000,"interval_months":12},
       {"task":"Air filter check","interval_hours":250}]'::jsonb),
    (null, 'bakkie', 'Bakkie / LDV', '[
       {"task":"Engine oil + filter","interval_hours":null,"interval_months":6},
       {"task":"Major service","interval_months":12}]'::jsonb),
    (null, 'harvester', 'Harvester', '[
       {"task":"Pre-season service","interval_months":12},
       {"task":"Engine oil + filter","interval_hours":250}]'::jsonb),
    (null, 'pump_generator', 'Pump / Generator', '[
       {"task":"Oil + filter","interval_hours":200,"interval_months":12}]'::jsonb);

  -- ── 12 machines across the Section 4.1 types ───────────────────
  insert into machines
    (id, farm_id, name, type, make, model, year, serial_no, reg_no, meter_type,
     status, current_reading, current_reading_date, purchase_date, purchase_price_cents,
     supplier, location, notes) values
    ('20000000-0000-0000-0000-000000000001', v_farm, 'Groen John Deere', 'tractor', 'John Deere', '6120M', 2019, 'JD6120M-01', null, 'hours', 'active',   4820, current_date - 2,  '2019-03-10', 145000000, 'Senwes', 'Werkswinkel', 'Hoof trekker vir lande'),
    ('20000000-0000-0000-0000-000000000002', v_farm, 'Rooi Massey',      'tractor', 'Massey Ferguson', '385', 2012, 'MF385-02', null, 'hours', 'active',   9130, current_date - 5,  '2012-06-01', 62000000,  'Afgri', 'Stoor', null),
    ('20000000-0000-0000-0000-000000000003', v_farm, 'Ou Ford',          'tractor', 'Ford', '6610', 1998, 'FORD6610-03', null, 'hours', 'standby', 15600, current_date - 40, '2005-01-15', 18000000, null, 'Agterste skuur', 'Reserwe trekker'),
    ('20000000-0000-0000-0000-000000000004', v_farm, 'New Holland Groot','tractor', 'New Holland', 'T7.210', 2021, 'NHT7-04', null, 'hours', 'in_workshop', 2210, current_date - 1, '2021-09-20', 210000000, 'New Holland SA', 'Werkswinkel', 'Ingeboek — hidroulika lek'),
    ('20000000-0000-0000-0000-000000000005', v_farm, 'Claas Stroper',    'harvester', 'Claas', 'Tucano 450', 2018, 'CLAAS450-05', null, 'hours', 'active', 3450, current_date - 7, '2018-02-01', 380000000, 'Claas SA', 'Masjienstoor', 'Graanstroper'),
    ('20000000-0000-0000-0000-000000000006', v_farm, 'John Deere Stroper','harvester', 'John Deere', 'S660', 2015, 'JDS660-06', null, 'hours', 'active', 5120, current_date - 9, '2015-04-12', 295000000, 'Senwes', 'Masjienstoor', null),
    ('20000000-0000-0000-0000-000000000007', v_farm, 'Wit Toyota Bakkie','bakkie', 'Toyota', 'Hilux 2.4 GD-6', 2020, 'AHV-VIN-07', 'CA 123-456', 'km', 'active', 148300, current_date - 1, '2020-07-01', 48000000, 'Toyota', 'Werf', 'Plaasbakkie'),
    ('20000000-0000-0000-0000-000000000008', v_farm, 'Isuzu Bakkie',     'bakkie', 'Isuzu', 'D-Max 250', 2017, 'ISZ-VIN-08', 'CA 654-321', 'km', 'active', 210500, current_date - 3, '2017-11-05', 39000000, 'Isuzu', 'Werf', null),
    ('20000000-0000-0000-0000-000000000009', v_farm, 'Mercedes Trok',    'truck', 'Mercedes-Benz', 'Actros 2645', 2016, 'MB-VIN-09', 'CA 987-654', 'km', 'active', 385000, current_date - 6, '2016-08-20', 165000000, null, 'Werf', 'Vervoer graan/vee'),
    ('20000000-0000-0000-0000-000000000010', v_farm, 'Planter 8-ry',     'implement', 'John Deere', '1755', 2018, 'JD1755-10', null, 'none', 'active', null, null, '2018-08-01', 52000000, 'Senwes', 'Implementstoor', 'Planter — geen meter'),
    ('20000000-0000-0000-0000-000000000011', v_farm, 'Sproeier',         'implement', 'Hardi', 'Navigator 3000', 2019, 'HARDI-11', null, 'none', 'active', null, null, '2019-05-01', 41000000, 'Hardi', 'Implementstoor', 'Trekker-gedrewe spuit'),
    ('20000000-0000-0000-0000-000000000012', v_farm, 'Waterpomp Lister', 'pump_generator', 'Lister', 'HR2', 2014, 'LISTER-12', null, 'hours', 'active', 1980, current_date - 15, '2014-03-01', 3500000, null, 'Besproeiingsdam', 'Diesel waterpomp');

  -- Cost-centre / department (F10, FR-3.4) so the machines-list filters have data.
  update machines set
    cost_centre = case type when 'harvester' then 'CC-200'
                            when 'bakkie' then 'CC-300' when 'truck' then 'CC-300' else 'CC-100' end,
    department  = case type when 'bakkie' then 'Vervoer' when 'truck' then 'Vervoer'
                            when 'implement' then 'Lande' else 'Werkswinkel' end
  where farm_id = v_farm;

  -- ── Meter reading history (last ~4 months) for metered machines ─
  insert into meter_readings (farm_id, machine_id, reading, reading_date, source, by_user)
  select v_farm, m.id,
         greatest(0, m.current_reading - (g.n * (case when m.meter_type = 'km' then 850 else 45 end)))::numeric,
         (current_date - (g.n * 21))::date,
         (case when g.n = 0 then 'manual' when g.n % 2 = 0 then 'qr' else 'whatsapp' end)::meter_source,
         (case when g.n % 2 = 0 then v_op1 else v_manager end)
  from machines m
  cross join generate_series(0, 4) as g(n)
  where m.farm_id = v_farm and m.meter_type in ('hours','km') and m.current_reading is not null;

  -- ── Service plan lines (some OK, some due-soon, one overdue) ────
  -- Engine oil (250h) for hours-metered machines
  insert into service_plan_lines
    (farm_id, machine_id, task, interval_hours, interval_months,
     last_done_reading, last_done_date, next_due_reading, next_due_date, status)
  select v_farm, m.id, 'Engine oil + filter', 250, 12,
         floor(m.current_reading/250)*250, current_date - 55,
         (floor(m.current_reading/250)+1)*250, current_date + 25,
         (case when (m.current_reading - floor(m.current_reading/250)*250) > 230 then 'due_soon' else 'ok' end)::service_line_status
  from machines m where m.farm_id = v_farm and m.meter_type = 'hours';

  -- Hydraulic/transmission (500h) for tractors
  insert into service_plan_lines
    (farm_id, machine_id, task, interval_hours, interval_months,
     last_done_reading, last_done_date, next_due_reading, next_due_date, status)
  select v_farm, m.id, 'Hydraulic / transmission service', 500, 24,
         floor(m.current_reading/500)*500, current_date - 120,
         (floor(m.current_reading/500)+1)*500, current_date + 60, 'ok'
  from machines m where m.farm_id = v_farm and m.type = 'tractor';

  -- Bakkie 6-monthly major service (one overdue for demo colour)
  insert into service_plan_lines
    (farm_id, machine_id, task, interval_hours, interval_months, last_done_date, next_due_date, status)
  values
    (v_farm, '20000000-0000-0000-0000-000000000007', 'Major service', null, 6, current_date - 200, current_date - 20, 'overdue'),
    (v_farm, '20000000-0000-0000-0000-000000000008', 'Major service', null, 6, current_date - 90,  current_date + 90, 'ok');

  -- ── Faults (mix of open + resolved) ────────────────────────────
  insert into faults (id, farm_id, machine_id, reported_by, reporter_name, description, category, urgency, status, created_at) values
    ('40000000-0000-0000-0000-000000000001', v_farm, '20000000-0000-0000-0000-000000000004', v_op1, 'Thabo', 'Hidroulika lek onder die masjien', 'hydraulic', 'limping', 'in_job', now() - interval '3 days'),
    ('40000000-0000-0000-0000-000000000002', v_farm, '20000000-0000-0000-0000-000000000001', v_op2, 'Sipho', 'Rook onder loading, verloor krag', 'noise', 'limping', 'resolved', now() - interval '35 days'),
    ('40000000-0000-0000-0000-000000000003', v_farm, '20000000-0000-0000-0000-000000000007', v_manager, 'Piet', 'Voorste band amper pap', 'tyre', 'can_work', 'open', now() - interval '1 day'),
    ('40000000-0000-0000-0000-000000000004', v_farm, '20000000-0000-0000-0000-000000000005', v_op1, 'Thabo', 'Stroper wil nie start nie', 'wont_start', 'stopped', 'open', now() - interval '6 hours'),
    ('40000000-0000-0000-0000-000000000005', v_farm, '20000000-0000-0000-0000-000000000002', v_op2, 'Sipho', 'Elektriese fout — ligte werk nie', 'electrical', 'can_work', 'resolved', now() - interval '70 days');

  -- ── Job cards (insert unlocked, add lines, then approve/lock one) ─
  insert into job_cards
    (id, farm_id, machine_id, created_from_fault_id, type, status, date_in, date_out,
     meter_reading, reported_problem, diagnosis, work_performed, recommendations,
     mechanic_user_id, workshop_id) values
    -- Completed 500h service on the Groen JD (resolved fault #2)
    ('30000000-0000-0000-0000-000000000001', v_farm, '20000000-0000-0000-0000-000000000001',
     '40000000-0000-0000-0000-000000000002', 'scheduled_service', 'completed',
     current_date - 34, current_date - 33, 4600,
     'Rook onder loading', 'Verstopte lugfilter + inspuiter diens', '500h diens gedoen; lugfilter vervang; inspuiters getoets',
     'Voorbande 50% — vervang voor planttyd', v_mech, v_workshop),
    -- Repair: Rooi Massey electrical (resolved fault #5)
    ('30000000-0000-0000-0000-000000000002', v_farm, '20000000-0000-0000-0000-000000000002',
     '40000000-0000-0000-0000-000000000005', 'repair', 'approved',
     current_date - 69, current_date - 68, 8950,
     'Ligte werk nie', 'Kortsluiting in kabelboom', 'Kabelboom herstel; sekerings vervang', null,
     v_mech, v_workshop),
    -- In-progress: New Holland hydraulic leak (fault #1)
    ('30000000-0000-0000-0000-000000000003', v_farm, '20000000-0000-0000-0000-000000000004',
     '40000000-0000-0000-0000-000000000001', 'repair', 'in_progress',
     current_date - 2, null, 2210,
     'Hidroulika lek', 'Besig om te ondersoek — vermoedelik seël', null, null, v_mech, v_workshop),
    -- Completed inspection: Claas pre-season
    ('30000000-0000-0000-0000-000000000004', v_farm, '20000000-0000-0000-0000-000000000005',
     null, 'inspection', 'completed', current_date - 20, current_date - 20, 3400,
     'Voor-seisoen inspeksie', 'Alles reg; klein slytasie op sny-onderdele', 'Volledige inspeksie', 'Hou dop: sny-onderdele', v_mech, v_workshop);

  insert into job_card_lines (farm_id, job_card_id, kind, description, part_no, qty, unit_cost_cents, hours, rate_cents) values
    -- JC1 parts + labour
    (v_farm, '30000000-0000-0000-0000-000000000001', 'part',   'Lugfilter', 'AF-2551', 1, 45000, null, null),
    (v_farm, '30000000-0000-0000-0000-000000000001', 'part',   'Enjinolie 18L', 'OIL-18', 1, 90000, null, null),
    (v_farm, '30000000-0000-0000-0000-000000000001', 'part',   'Oliefilter', 'OF-119', 2, 15000, null, null),
    (v_farm, '30000000-0000-0000-0000-000000000001', 'labour', 'Diens arbeid', null, null, null, 3.5, 45000),
    (v_farm, '30000000-0000-0000-0000-000000000001', 'other',  'Vervoer / uitroep', null, null, 35000, null, null),
    -- JC2 parts + labour
    (v_farm, '30000000-0000-0000-0000-000000000002', 'part',   'Sekering stel', null, 1, 8000, null, null),
    (v_farm, '30000000-0000-0000-0000-000000000002', 'labour', 'Elektriese herstel', null, null, null, 2.0, 45000),
    -- JC4 labour only
    (v_farm, '30000000-0000-0000-0000-000000000004', 'labour', 'Inspeksie', null, null, null, 1.5, 45000);

  -- Approve + lock JC2 (money/history is now tamper-evident)
  update job_cards
     set status = 'approved', approved_by = v_owner, approved_at = now() - interval '67 days', locked = true
   where id = '30000000-0000-0000-0000-000000000002';

  -- Link faults to the job card that handled them (the fault "trail", Scope §4.5)
  update faults set job_card_id = '30000000-0000-0000-0000-000000000001', resolved_at = now() - interval '33 days'
   where id = '40000000-0000-0000-0000-000000000002';
  update faults set job_card_id = '30000000-0000-0000-0000-000000000002', resolved_at = now() - interval '68 days'
   where id = '40000000-0000-0000-0000-000000000005';
  update faults set job_card_id = '30000000-0000-0000-0000-000000000003'
   where id = '40000000-0000-0000-0000-000000000001';   -- in_job, not yet resolved

  -- ── Watch items (open, from job cards) ─────────────────────────
  insert into watch_items (farm_id, machine_id, source_job_card_id, text, status) values
    (v_farm, '20000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000001', 'Voorbande 50% — vervang voor planttyd', 'open'),
    (v_farm, '20000000-0000-0000-0000-000000000005', '30000000-0000-0000-0000-000000000004', 'Hou dop: stroper sny-onderdele slytasie', 'open');

  -- ── A couple of attachment rows (placeholder URLs) ─────────────
  insert into attachments (farm_id, parent_type, parent_id, kind, url, created_by) values
    (v_farm, 'machine', '20000000-0000-0000-0000-000000000001', 'photo', 'demo://groen-jd.jpg', v_owner),
    (v_farm, 'fault',   '40000000-0000-0000-0000-000000000004', 'photo', 'demo://stroper-fault.jpg', v_op1);

  -- ── Fuel module demo (F4): tank, deliveries, per-machine draws ──
  -- Draws are ex-VAT costed (~R18.26/L). The Groen John Deere series runs a steady
  -- ~12 L/hr then spikes to 19 L/hr (a possible leak/theft the anomaly engine flags);
  -- the Toyota bakkie shows a steady ~12 L/100km.
  insert into fuel_tanks (id, farm_id, name, capacity_l) values
    ('60000000-0000-0000-0000-000000000001', v_farm, 'Hoof dieseltenk', 10000);

  insert into fuel_deliveries (farm_id, tank_id, date, supplier, invoice_no, litres, price_per_l_cents, vat_rate_bps, by_user) values
    (v_farm, '60000000-0000-0000-0000-000000000001', current_date - 90, 'Senwes', 'INV-4471', 5000, 1826, 1500, v_owner),
    (v_farm, '60000000-0000-0000-0000-000000000001', current_date - 30, 'Senwes', 'INV-4620', 5000, 1826, 1500, v_owner);

  insert into fuel_issues (farm_id, tank_id, machine_id, date, litres, meter_reading, cost_cents, price_per_l_cents, vat_rate_bps, activity, by_user) values
    -- Groen John Deere (hours): ~12 L/hr baseline, final draw anomalous (19 L/hr).
    (v_farm, '60000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000001', current_date - 100, 1200, 4320, 2191200, 1826, 1500, 'ploughing',  v_op1),
    (v_farm, '60000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000001', current_date - 80,  1150, 4420, 2099900, 1826, 1500, 'ploughing',  v_op1),
    (v_farm, '60000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000001', current_date - 60,  1250, 4520, 2282500, 1826, 1500, 'planting',   v_op1),
    (v_farm, '60000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000001', current_date - 40,  1200, 4620, 2191200, 1826, 1500, 'spraying',   v_op1),
    (v_farm, '60000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000001', current_date - 20,  1180, 4720, 2154680, 1826, 1500, 'harvesting', v_op1),
    (v_farm, '60000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000001', current_date - 2,   1900, 4820, 3469400, 1826, 1500, 'harvesting', v_op1),
    -- Wit Toyota Bakkie (km): steady ~12 L/100km.
    (v_farm, '60000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000007', current_date - 100,  300, 145000,  547800, 1826, 1500, 'transport', v_op1),
    (v_farm, '60000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000007', current_date - 80,    96, 145800,  175296, 1826, 1500, 'transport', v_op1),
    (v_farm, '60000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000007', current_date - 55,   100, 146600,  182600, 1826, 1500, 'transport', v_op1),
    (v_farm, '60000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000007', current_date - 25,    92, 147400,  167992, 1826, 1500, 'transport', v_op1),
    (v_farm, '60000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000007', current_date - 1,    105, 148300,  191730, 1826, 1500, 'transport', v_op1);

  -- Run the anomaly sweep once so the demo shows the flagged draw + a fuel_anomaly alert.
  perform app.enqueue_fuel_anomalies();

  -- ── Parts catalogue + a service kit (F9) ───────────────────────
  -- A couple of GLOBAL (RR-seeded) parts + this farm's own parts; all money ex-VAT cents.
  insert into parts_catalogue (id, farm_id, part_no, description, supplier, category, typical_cost_cents, created_by) values
    ('70000000-0000-0000-0000-000000000001', null,   'JD-RE504836', 'John Deere oil filter',        'John Deere', 'filter', 32000,  v_mech),
    ('70000000-0000-0000-0000-000000000002', null,   'JD-RE509672', 'John Deere fuel filter',       'John Deere', 'filter', 41000,  v_mech),
    ('70000000-0000-0000-0000-000000000003', v_farm, 'OIL-15W40-20L','Engine oil 15W40 20L drum',   'Senwes',     'oil',    128000, v_mech),
    ('70000000-0000-0000-0000-000000000004', v_farm, 'HYD-68-20L',   'Hydraulic oil ISO 68 20L',    'Afgri',      'oil',    112000, v_mech);

  -- The 250h service kit for the Groen John Deere (parts BOM referencing catalogue rows).
  insert into service_kits (id, farm_id, machine_id, name, notes, created_by) values
    ('71000000-0000-0000-0000-000000000001', v_farm, '20000000-0000-0000-0000-000000000001', '250h diens-stel',
     'Enjinolie, oliefilter en brandstoffilter', v_mech);
  insert into service_kit_items (farm_id, service_kit_id, part_catalogue_id, part_no, description, qty, unit_cost_cents) values
    (v_farm, '71000000-0000-0000-0000-000000000001', '70000000-0000-0000-0000-000000000003', 'OIL-15W40-20L', 'Engine oil 15W40 20L drum', 1, 128000),
    (v_farm, '71000000-0000-0000-0000-000000000001', '70000000-0000-0000-0000-000000000001', 'JD-RE504836',   'John Deere oil filter',     1,  32000),
    (v_farm, '71000000-0000-0000-0000-000000000001', '70000000-0000-0000-0000-000000000002', 'JD-RE509672',   'John Deere fuel filter',    1,  41000);

  -- ── Partners directory (F12a) ──────────────────────────────────
  -- GLOBAL suggested partners (RR-curated, farm_id null, is_suggested true) that every
  -- farm sees, plus this farm's own contractors — one already connected to TJ's workshop.
  insert into partners (farm_id, is_suggested, name, kind, phone, whatsapp, email, area, workshop_id, notes, created_by) values
    (null,   true,  'AgriParts Wholesale',   'parts_supplier',   '+27514440101', '+27514440101', 'sales@agriparts.example', 'Welkom',     null,        'Bulk filters, oils and belts', null),
    (null,   true,  'Vrystaat Auto Electric', 'auto_electrician', '+27514440202', '+27514440202', 'info@vsauto.example',     'Bloemfontein', null,      'Alternators, starters, wiring', null),
    (null,   true,  'Highway Towing 24/7',    'towing',           '+27824440303', '+27824440303', null,                      'N1 corridor', null,       'Heavy recovery, day and night', null),
    (v_farm, false, 'TJ Service & Repairs',   'mechanic',         '+27825550134', '+27825550134', 'tj@tjrepairs.example',    'Bothaville',  v_workshop, 'Our main mechanic — connected', v_owner),
    (v_farm, false, 'Bothaville Tyres',       'tyre',             '+27825550777', '+27825550777', 'shop@bvtyres.example',    'Bothaville',  null,       'Tractor + bakkie tyres',        v_owner);

  -- ── Work requests (F12b) — jobs sent to the TJ contractor ──────
  -- One fresh request (awaiting the contractor), one already invoiced so the invoice
  -- flows into the machine's TCO via the 0311 sync trigger (no double-count).
  insert into work_requests (id, farm_id, machine_id, workshop_id, kind, status, priority, title, description, vat_rate_bps, created_by) values
    ('72000000-0000-0000-0000-000000000001', v_farm, '20000000-0000-0000-0000-000000000004', v_workshop, 'repair', 'requested', 'high',
     'Hidroulika lek', 'Lek onder die masjien — kom kyk asseblief', 1500, v_owner),
    ('72000000-0000-0000-0000-000000000002', v_farm, '20000000-0000-0000-0000-000000000005', v_workshop, 'inspection', 'invoiced', 'normal',
     'Voor-seisoen inspeksie', 'Volledige inspeksie voor stroopseisoen', 1500, v_manager);

  insert into work_request_events (farm_id, work_request_id, from_status, to_status, note, by_user) values
    (v_farm, '72000000-0000-0000-0000-000000000001', null, 'requested', 'Aangevra by TJ', v_owner),
    (v_farm, '72000000-0000-0000-0000-000000000002', null, 'requested', 'Aangevra by TJ', v_manager),
    (v_farm, '72000000-0000-0000-0000-000000000002', 'requested', 'completed', 'Inspeksie gedoen', v_wstaff),
    (v_farm, '72000000-0000-0000-0000-000000000002', 'completed', 'invoiced', 'Faktuur gestuur', v_wstaff);

  -- Recording the invoice amount (ex-VAT) books a single 'invoice' cost_entry via 0311.
  update work_requests set invoice_amount_cents = 180000
   where id = '72000000-0000-0000-0000-000000000002';

  raise notice 'demo farm "Weltevrede Boerdery" seeded: 12 machines with histories + fuel + partners + work requests';
end
$seed$;
