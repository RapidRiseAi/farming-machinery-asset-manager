# Corporate fleets and trucking: what FleetWise has, and what it would need

Written 4 November 2026 for the founder. FleetWise was built for farms; this is a view of
what larger fleets (corporate, municipal, construction, mining contractors) and trucking
operators expect, checked against what is in the app today. Recommendations, not commitments:
nothing here is built by this note.

## What already carries over well

These are real, shipped capabilities a corporate or trucking buyer will recognise:

- **Asset register** with photos, documents, cost centres, departments and sites; CSV import.
- **Servicing by hours, kilometres or calendar**, service kits, due and overdue tracking.
- **Faults, inspections and checklists** (a pre-trip check is a checklist template), with
  photos and voice notes, and a fault-to-job-card workflow.
- **Job cards and workshop collaboration**: outside workshops quote, work and invoice inside
  the app, with an audit trail.
- **Parts and stock**, tyres (fitments, movements, inspections), warranties and warranty
  claim packs.
- **Vehicle compliance per asset**: licence discs, roadworthy, permits, cross-border permits
  and insurance, with expiry notifications.
- **Driver compliance**: driver's licence codes, PrDP (goods, passengers, dangerous goods)
  and operator competency certificates, with expiry dates.
- **Incidents and insurance claims**; **AARTO fines and driver nomination** (Complete).
- **Fuel**: bowsers, dips, tank reconciliation, consumption per hour or 100 km, unusual-use
  flags, SARS diesel logbook export (Professional).
- **Money**: total cost of ownership, cost per km or hour, budgets, book value, finance
  and lease agreements, accounting journal exports.
- **People and access**: roles, per-person permissions, multi-site membership, the combined
  view of a person's farms (built 4 November), staff two-step sign-in, audit log, POPIA work.
- **Channels**: English and Afrikaans, offline capture of the common actions, push and
  email notifications, the AI assistant (voice and typed), WhatsApp (text, voice notes and
  photos), and a public API for Done-For-You customers.
- **Driver activity**: manual start/arrive/depart/end logs, and a provider-feed endpoint
  for trackers and key tags (Done-For-You, per-provider adapter still to be written).

## What a trucking or corporate buyer will ask for, in priority order

Effort is a rough size for one developer: S (days), M (one to two weeks), L (three to six
weeks), XL (more).

### 1. Goods-vehicle compliance (S to M, Professional)
South African operators are audited on these, and the data model is close already.
- **Certificate of Fitness (COF)** for goods vehicles over 3 500 kg and passenger vehicles,
  as a licence type with its annual test date and the testing station.
- **NRTA operator registration and operator cards** per vehicle.
- **Dangerous goods**: vehicle permits and driver DG training certificates (SANS 10231),
  alongside the existing PrDP-D.
- **Abnormal load permits** (route, dates, conditions) for the operators who need them.
- **Driver medical certificates** and training records as credential types.
- An **RTMS-style compliance pack**: one document per vehicle and driver for an audit.

### 2. Trips, loads and proof of delivery (L, new Complete module)
The core of a trucking business, and the biggest gap. Today FleetWise knows the vehicle,
not the work it does.
- **Trip sheets**: who drove what, from where to where, opening and closing odometer, fuel,
  tolls and expenses, signed off by the driver.
- **Loads and waybills**: customer, consignment, weight, seal numbers; **proof of delivery**
  by photo and signature on the phone, offline-capable.
- **Revenue per trip and per km**, so cost per km (already there) meets income per km.
- **Trailer pairing**: which trailer was behind which horse on which trip; trailers as
  assets with their own services (axles, brakes) and COF.

### 3. Telematics integration (M per provider, Done-For-You)
The driving-feed endpoint exists; each provider still needs an adapter.
- **MiX Telematics, Cartrack, Netstar, Ctrack** cover most South African fleets; start with
  whichever the first paying customer uses.
- Pull **odometer and engine hours automatically** (no more typed readings), trips,
  location history and **driver behaviour** (harsh braking, speeding, idling).
- **Geofences** for depots and sites; alerts when a vehicle leaves hours or areas.

### 4. Fuel cards (M, Professional or Done-For-You)
- Import **fuel-card statements** (Standard Bank, Absa, WesBank, FNB fleet cards) by file
  first, then by feed.
- **Reconcile** card fills against vehicle, tank capacity and odometer; flag fills on the
  wrong vehicle, over capacity or too close together. This is the fraud check fleet
  managers pay for.

### 5. Driver hours and fatigue (M, Complete)
- **Driving and rest time** per driver from trip sheets or telematics, against the
  operator's own policy (South Africa has no tachograph law, but RTMS and clients expect
  fatigue management).
- Warnings before a driver exceeds their hours; a fatigue report for audits.

### 6. Approvals and purchasing for the fleet owner (M, Professional)
Corporate buyers have spending authorities.
- **Approval limits by role** for job cards, quotes and purchases (a manager approves to
  R10 000, the owner above).
- **Purchase requisitions and orders** on the fleet side (the partner side has orders
  already), with the PO number on the supplier invoice.
- **Vehicle recharging**: allocate costs to customers, contracts or cost centres.

### 7. Enterprise access (M, Complete or quoted)
- **Single sign-on** (Microsoft Entra ID, Google Workspace) and user provisioning from the
  company directory.
- **Two-step sign-in for everyone** (it is staff-only today), session and IP policies.
- A **data retention and export policy** a procurement team can read.

### 8. Group structures and billing (L, needed for the website's pooled offer)
- A **billing customer above farms/depots**: one subscription, pooled slots and one
  minimum across a group's sites (the website already describes this; the app bills per farm).
- **Asset transfers between sites** with their history.
- **Monthly invoicing by EFT or debit order** with purchase-order numbers, annual contracts,
  and VAT invoices once Rapid Rise registers.

### 9. Pool vehicles (S to M, Professional)
- **Booking and check-out/check-in** of pool vehicles with odometer, fuel and condition
  photos; who had the car when the fine came.

### 10. Reporting a corporate expects (M, Professional)
- **KPIs by vehicle class**: cost per km, utilisation, downtime, mean time between failures.
- **Carbon and fuel emissions** reporting from fuel records (ESG and carbon-tax questions
  are now routine in procurement).
- **Power BI / Excel connector** or scheduled data exports per table.

### 11. Driver languages and the driver app (M)
- isiZulu, isiXhosa and Sesotho for the driver-facing screens; English and Afrikaans stay
  for managers.
- A store-installed app wrapper, if fleet IT departments require one (the web app installs
  as a PWA today).

## Suggested order

1. **Goods-vehicle compliance** (item 1): small, close to existing tables, and it lets you
   sell to trucking operators straight away.
2. **Pooled group billing** (item 8): the website already promises it.
3. **One telematics adapter**, for the first customer who has a provider (item 3).
4. **Trips, loads and POD** (item 2): the module that turns FleetWise from maintenance
   software into trucking software. Price it on Complete or as an add-on.
5. Fuel cards, approvals and SSO as corporate deals ask for them.

## Pricing thoughts

- Trucking operators accept higher per-asset prices than farms; a **Trucking add-on** (trips,
  POD, driver hours) at R40 to R60 per truck a month on top of Complete is in line with
  local telematics-adjacent software.
- Telematics adapters fit **Done-For-You** as quoted integration work.
- Enterprise access (SSO, retention policies) is commonly a **quoted enterprise tier**
  rather than a list price.

These are suggestions for you to test with the first corporate prospects, not approved prices.
