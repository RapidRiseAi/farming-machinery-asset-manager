/**
 * FleetWise UI kit. Import from "@/components/ui".
 * Server-compatible unless a component's file is marked "use client"
 * (Modal, Sheet, Overlay, Toast, Tabs, SubmitButton, NavLink, MoreMenu, PageInfo,
 * ClearResultParams, DialogForm, ActionMenu, ConfirmDialog, CommandPalette,
 * FilterBar, SearchField). Plain functions (`backHref`, `withoutResultParams`,
 * `filterState`, `withTab`, `readTab`, ...) come from plain modules, never from a
 * "use client" one: a plain function exported from a client module is a client
 * reference that throws when a Server Component or a server action calls it.
 */
export { cn } from "./cn";
export * from "./icons";
export { Button, buttonVariants } from "./button";
export type { ButtonProps, ButtonVariant, ButtonSize } from "./button";
export { SubmitButton } from "./submit-button";
export type { SubmitButtonProps } from "./submit-button";
export { Input, controlBase } from "./input";
export { CommandPalette } from "./command-palette";
export type { CommandLabels } from "./command-palette";
export type { InputProps } from "./input";
export { Select } from "./select";
export type { SelectProps } from "./select";
export { Textarea } from "./textarea";
export type { TextareaProps } from "./textarea";
export { Field, TextField, SelectField, TextareaField } from "./field";
export type { FieldProps, TextFieldProps, SelectFieldProps, TextareaFieldProps } from "./field";
export { Card, CardHeader, CardTitle } from "./card";
export type { CardProps, CardHeaderProps, CardTitleProps } from "./card";
export { Table, Thead, Tbody, Tr, Th, Td } from "./table";
export type { ThProps, TdProps } from "./table";
export {
  Badge, StatusPill, StatusBadge, look,
  SERVICE_LOOK, MACHINE_LOOK, JOB_LOOK, FAULT_LOOK, URGENCY_LOOK,
  WORK_LOOK, PRIORITY_LOOK, EXPIRY_LOOK, BUDGET_LOOK, FINE_LOOK,
} from "./badge";
export type {
  BadgeProps, BadgeTone, StatusPillProps, ServiceStatus,
  StatusBadgeProps, StatusShape, StatusLook,
} from "./badge";
export { Stat, StatGrid } from "./stat";
export { Fact, FactList } from "./facts";
export type { FactProps } from "./facts";
export type { StatProps, StatTone, StatSize, StatValueKind } from "./stat";
export { Modal, Sheet, Overlay } from "./dialog";
export type { ModalProps, SheetProps } from "./dialog";
export { DialogForm, DialogActions, DialogFields, DialogSection, useDialogForm } from "./dialog-form";
export type { DialogFormProps } from "./dialog-form";
export { ActionMenu, MenuSection } from "./action-menu";
export { menuItemClass } from "./menu-item";
export type { ActionMenuProps } from "./action-menu";
export { Disclosure } from "./disclosure";
export type { DisclosureProps } from "./disclosure";
export { ConfirmDialog } from "./confirm-dialog";
export type { ConfirmDialogProps, ConfirmFact, ConfirmTone } from "./confirm-dialog";
export { FilterBar } from "./filter-bar";
export type { FilterBarSearchField } from "./filter-bar";
export { filterState, hasActiveFilters, clearFiltersHref, hrefWithParams } from "./filter-state";
export type { ChipOption, FilterGroup } from "./filter-state";
export { SearchField } from "./search-field";
export type { SearchFieldProps } from "./search-field";
export { Checkbox } from "./checkbox";
export type { CheckboxProps } from "./checkbox";
export { DateText } from "./date-text";
export type { DateTextFormat } from "./date-text";
export { Flash, KeepResultParams } from "./flash";
export type { FlashProps, FlashTone } from "./flash";
export { ClearResultParams } from "./clear-result-params";
export { RESULT_PARAMS, withoutResultParams } from "./result-params";
export { PageHeader, PageContainer, BackLink } from "./page-header";
export type { PageHeaderProps, PageContainerProps, PageWidth, BackTarget } from "./page-header";
export { backHref } from "./back-href";
export { PageInfoButton } from "./page-info-button";
export { PageInfo } from "./page-info";
export type { PageInfoContent } from "./page-info";
export { Toast } from "./toast";
export type { ToastProps } from "./toast";
export { Tabs } from "./tabs";
export type { TabsProps, TabItem } from "./tabs";
export { withTab, readTab } from "./tabs-url";
export { EmptyState, AllClear, GetStarted, NoMatches, FilteredEmpty } from "./empty-state";
export type { EmptyStateProps, NoMatchesProps } from "./empty-state";
export { Skeleton, SkeletonText } from "./skeleton";
export type { SkeletonProps } from "./skeleton";
// Not `PageSkeleton`: it reads the device language with next/headers, so it is
// server-only and a Client Component importing this barrel would break. Import it from
// "./page-skeleton" in a route's loading.tsx.
export { NavLink, MoreMenu } from "./nav";
export type { NavItemData } from "./nav";
