/**
 * Minimal declarations for the Tabulator pieces the Profiles sheet uses. The
 * package ships no types, so the surface below is exactly what the module
 * calls. Widen it only when the sheet needs more.
 */
declare module "tabulator-tables" {
  export interface TabulatorCell {
    getValue(): unknown;
    getField(): string;
    getRow(): TabulatorRow;
    getElement(): HTMLElement;
    getOldValue(): unknown;
    setValue(value: unknown, mutate?: boolean): void;
    restoreOldValue(): void;
  }
  export interface TabulatorRow {
    getData(): Record<string, unknown>;
    update(data: Record<string, unknown>): Promise<void>;
    getElement(): HTMLElement;
    reformat(): void;
  }
  export interface TabulatorColumnDefinition {
    title: string;
    field?: string;
    visible?: boolean;
    frozen?: boolean;
    resizable?: boolean;
    headerSort?: boolean;
    editor?: string;
    editable?: boolean | ((cell: TabulatorCell) => boolean);
    formatter?: (cell: TabulatorCell) => string | HTMLElement;
    width?: number;
    minWidth?: number;
    cssClass?: string;
    headerTooltip?: string | boolean;
    editorParams?: Record<string, unknown>;
    cellEdited?: (cell: TabulatorCell) => void;
    cellEditCancelled?: (cell: TabulatorCell) => void;
  }
  export interface TabulatorColumn {
    show(): void;
    hide(): void;
    isVisible(): boolean;
  }
  export interface TabulatorOptions {
    index?: string;
    columns: TabulatorColumnDefinition[];
    layout?: string;
    height?: string | number;
    renderVertical?: string;
    renderHorizontal?: string;
    pagination?: boolean;
    paginationMode?: string;
    paginationElement?: HTMLElement;
    paginationOutOfRange?: "last";
    paginationSize?: number;
    paginationSizeSelector?: number[];
    paginationCounter?: string | ((...args: number[]) => string);
    locale?: string;
    langs?: Record<string, { pagination?: { page_size?: string } }>;
    sortMode?: string;
    ajaxURL?: string;
    ajaxRequestFunc?: (
      url: string,
      config: unknown,
      params: Record<string, unknown>,
    ) => Promise<unknown>;
    initialSort?: { column: string; dir: string }[];
    placeholder?: string;
    resizableColumnFit?: boolean;
    headerSortClickElement?: string;
    movableColumns?: boolean;
    editTriggerEvent?: string;
    rowFormatter?: (row: TabulatorRow) => void;
    ajaxLoaderLoading?: string;
    ajaxLoaderError?: string;
    keybindings?: Record<string, string | boolean>;
    tabEndNewRow?: boolean;
  }
  export class Tabulator {
    constructor(element: HTMLElement, options: TabulatorOptions);
    static registerModule(modules: unknown[]): void;
    element: HTMLElement;
    on(event: string, callback: (...args: never[]) => void): void;
    setData(): Promise<void>;
    setPage(page: number | string): Promise<void>;
    getPage(): number | false;
    getRows(): TabulatorRow[];
    getColumn(field: string): TabulatorColumn | false;
    showColumn(field: string): void;
    hideColumn(field: string): void;
    redraw(force?: boolean): void;
    destroy(): void;
    replaceData(data?: unknown): Promise<void>;
  }
  export const AjaxModule: unknown;
  export const PageModule: unknown;
  export const SortModule: unknown;
  export const FormatModule: unknown;
  export const EditModule: unknown;
  export const ResizeColumnsModule: unknown;
  export const FrozenColumnsModule: unknown;
  export const InteractionModule: unknown;
  export const KeybindingsModule: unknown;
  export const ResizeTableModule: unknown;
}
