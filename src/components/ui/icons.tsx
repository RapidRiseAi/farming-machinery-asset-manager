import type { SVGProps } from "react";

/**
 * Hand-rolled inline SVG icons — no icon pack dependency (Scope §7, keep the
 * bundle lean). All icons share a 24x24 viewBox, use `currentColor`, and are a
 * consistent 1.75-weight line style. They are decorative by default
 * (`aria-hidden`); give an interactive parent an accessible label instead.
 */
export type IconProps = SVGProps<SVGSVGElement> & { title?: string };

function Svg({ title, children, ...props }: IconProps & { children: React.ReactNode }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width="1em"
      height="1em"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden={title ? undefined : true}
      role={title ? "img" : undefined}
      {...props}
    >
      {title ? <title>{title}</title> : null}
      {children}
    </svg>
  );
}

export const DashboardIcon = (p: IconProps) => (
  <Svg {...p}>
    <rect x="3" y="3" width="7" height="9" rx="1.5" />
    <rect x="14" y="3" width="7" height="5" rx="1.5" />
    <rect x="14" y="12" width="7" height="9" rx="1.5" />
    <rect x="3" y="16" width="7" height="5" rx="1.5" />
  </Svg>
);

export const MachinesIcon = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="7" cy="17" r="3" />
    <circle cx="17.5" cy="17.5" r="2.5" />
    <path d="M10 17h4.5M4 17V7h5l2 4h3V7" />
    <path d="M14 11V7h3l2 4" />
  </Svg>
);

export const JobCardsIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M8 4h8a2 2 0 0 1 2 2v13a1 1 0 0 1-1.5.87L12 18l-4.5 1.87A1 1 0 0 1 6 19V6a2 2 0 0 1 2-2Z" />
    <path d="M9 9h6M9 12.5h4" />
  </Svg>
);

export const FaultsIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12 3.5 2.5 20a1 1 0 0 0 .87 1.5h17.26A1 1 0 0 0 21.5 20L12 3.5Z" />
    <path d="M12 9.5v4.5M12 17.5h.01" />
  </Svg>
);

export const ReportsIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M5 21V4a1 1 0 0 1 1-1h9l4 4v14a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1Z" />
    <path d="M14 3v4h4" />
    <path d="M9 13v4M12 11v6M15 15v2" />
  </Svg>
);

export const BellIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M6 9a6 6 0 0 1 12 0c0 5 2 6 2 6H4s2-1 2-6Z" />
    <path d="M10.5 20a1.8 1.8 0 0 0 3 0" />
  </Svg>
);

export const TeamIcon = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="9" cy="8" r="3.2" />
    <path d="M3.5 20a5.5 5.5 0 0 1 11 0" />
    <path d="M16 5.2a3.2 3.2 0 0 1 0 6.1M17 14.2a5.5 5.5 0 0 1 3.5 5.8" />
  </Svg>
);

export const SettingsIcon = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-2.82 1.17V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 7 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 2.6 15H2.5a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4 9.4a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6h.09A1.65 1.65 0 0 0 11 2.5a2 2 0 0 1 4 0v.09A1.65 1.65 0 0 0 17 4.6a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 21.4 9v.09a2 2 0 0 1 0 4Z" />
  </Svg>
);

export const AdminIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12 3 4 6v5c0 4.5 3.2 7.8 8 9 4.8-1.2 8-4.5 8-9V6l-8-3Z" />
    <path d="M9.2 12l2 2 3.6-3.8" />
  </Svg>
);

export const MenuIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4 7h16M4 12h16M4 17h16" />
  </Svg>
);

export const MoreIcon = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="5" cy="12" r="1.4" />
    <circle cx="12" cy="12" r="1.4" />
    <circle cx="19" cy="12" r="1.4" />
  </Svg>
);

export const CloseIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M6 6l12 12M18 6 6 18" />
  </Svg>
);

export const ChevronRightIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M9 6l6 6-6 6" />
  </Svg>
);

export const ChevronLeftIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M15 6l-6 6 6 6" />
  </Svg>
);

export const ChevronDownIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M6 9l6 6 6-6" />
  </Svg>
);

export const ChevronUpIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M6 15l6-6 6 6" />
  </Svg>
);

export const PlusIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12 5v14M5 12h14" />
  </Svg>
);

export const SearchIcon = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="11" cy="11" r="7" />
    <path d="m20 20-3.2-3.2" />
  </Svg>
);

export const CheckIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M5 12.5l4.5 4.5L19 7" />
  </Svg>
);

export const WarningIcon = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 7.5V13M12 16.5h.01" />
  </Svg>
);

export const InfoIcon = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 11v5M12 7.75h.01" />
  </Svg>
);

export const SignOutIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M15 12H4M9 8l-4 4 4 4" />
    <path d="M12 4h6a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1h-6" />
  </Svg>
);

export const FuelIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4 21V6a2 2 0 0 1 2-2h6a2 2 0 0 1 2 2v15" />
    <path d="M3 21h12" />
    <path d="M7 9h4" />
    <path d="M14 8l3 2.2a2 2 0 0 1 .8 1.6V17a1.6 1.6 0 0 0 3.2 0v-6l-2.4-2.4" />
  </Svg>
);

/** Parts catalogue / service kit — a nut-and-bolt style cog. */
export const PartsIcon = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="3" />
    <path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M19.1 4.9L17 7M7 17l-2.1 2.1" />
  </Svg>
);

export const InboxIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M3 13h4l1.5 3h7L17 13h4" />
    <path d="M5 5h14l2 8v5a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-5L5 5Z" />
  </Svg>
);

/** Partners / contractors — a handshake. */
export const PartnersIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M8 13.5 5 10.5a2 2 0 0 1 0-2.8l2-2a2 2 0 0 1 2.6-.2L12 7l2.4-1.7a2 2 0 0 1 2.6.2l2 2a2 2 0 0 1 0 2.8L18 13" />
    <path d="m8 13.5 2 2a1.5 1.5 0 0 0 2.1 0M10 15.5l1.5 1.5a1.5 1.5 0 0 0 2.1 0M13.6 17l1 1a1.5 1.5 0 0 0 2.1-2.1L18 14.5" />
  </Svg>
);

export const PhoneIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4 5a1 1 0 0 1 1-1h2.3a1 1 0 0 1 1 .76l.7 2.8a1 1 0 0 1-.3 1L7.3 10a12 12 0 0 0 5.7 5.7l1.4-1.4a1 1 0 0 1 1-.3l2.8.7a1 1 0 0 1 .76 1V18a1 1 0 0 1-1 1A15 15 0 0 1 4 6Z" />
  </Svg>
);

/** WhatsApp / chat bubble. */
export const ChatIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4 12a8 8 0 1 1 3.5 6.6L4 20l1.4-3.5A8 8 0 0 1 4 12Z" />
    <path d="M9 10.5c0 2.5 2 4.5 4.5 4.5" />
  </Svg>
);

export const MailIcon = (p: IconProps) => (
  <Svg {...p}>
    <rect x="3" y="5" width="18" height="14" rx="2" />
    <path d="m4 7 8 5 8-5" />
  </Svg>
);

/** A link / connect chain. */
export const LinkIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M9.5 14.5 14.5 9.5" />
    <path d="M8 12.5 6.5 14a3 3 0 0 0 4.2 4.2l1.8-1.7" />
    <path d="M16 11.5 17.5 10a3 3 0 0 0-4.2-4.2l-1.8 1.7" />
  </Svg>
);

export const CopyIcon = (p: IconProps) => (
  <Svg {...p}>
    <rect x="9" y="9" width="11" height="11" rx="2" />
    <path d="M6 15H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v1" />
  </Svg>
);

/** Vehicle checklist / inspection — a clipboard with a tick. */
export const ChecklistIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M9 4h6a1 1 0 0 1 1 1v1a1 1 0 0 1-1 1H9a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1Z" />
    <path d="M8 5H6a1 1 0 0 0-1 1v13a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V6a1 1 0 0 0-1-1h-2" />
    <path d="M8.5 12.5l2 2 3.5-4" />
  </Svg>
);

/** A small spinning loader used by buttons in their pending state. */
export const Spinner = ({ className, ...props }: SVGProps<SVGSVGElement>) => (
  <svg
    viewBox="0 0 24 24"
    width="1em"
    height="1em"
    fill="none"
    className={className}
    aria-hidden
    {...props}
  >
    <circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity="0.25" strokeWidth="3" />
    <path
      d="M21 12a9 9 0 0 0-9-9"
      stroke="currentColor"
      strokeWidth="3"
      strokeLinecap="round"
      className="origin-center animate-spin"
    />
  </svg>
);

/** String-keyed icon lookup — lets server components pass a serializable
 *  `name` across the client boundary (nav config) instead of a component. */
export const iconByName = {
  dashboard: DashboardIcon,
  machines: MachinesIcon,
  jobcards: JobCardsIcon,
  faults: FaultsIcon,
  reports: ReportsIcon,
  fuel: FuelIcon,
  parts: PartsIcon,
  partners: PartnersIcon,
  checklists: ChecklistIcon,
  bell: BellIcon,
  team: TeamIcon,
  settings: SettingsIcon,
  admin: AdminIcon,
  menu: MenuIcon,
  more: MoreIcon,
  close: CloseIcon,
  plus: PlusIcon,
  search: SearchIcon,
  check: CheckIcon,
  warning: WarningIcon,
  info: InfoIcon,
  inbox: InboxIcon,
  signout: SignOutIcon,
  "chevron-right": ChevronRightIcon,
  "chevron-left": ChevronLeftIcon,
  "chevron-down": ChevronDownIcon,
  "chevron-up": ChevronUpIcon,
} as const;

export type IconName = keyof typeof iconByName;

/** Render an icon by its string name (used by the app-shell nav). */
export function Icon({ name, ...props }: { name: IconName } & IconProps) {
  const Cmp = iconByName[name];
  return <Cmp {...props} />;
}
