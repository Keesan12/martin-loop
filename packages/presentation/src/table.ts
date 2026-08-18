import { padRightVisible, truncateVisible, visibleWidth } from "./text.js";

export interface TableColumn<Row> {
  readonly header: string;
  readonly value: (row: Row) => string;
  readonly minWidth?: number;
  readonly maxWidth?: number;
}

export interface RenderTableOptions {
  readonly separator?: string;
  readonly width?: number;
}

function columnWidth<Row>(rows: readonly Row[], column: TableColumn<Row>): number {
  const contentWidth = Math.max(
    visibleWidth(column.header),
    ...rows.map((row) => visibleWidth(column.value(row))),
    column.minWidth ?? 0,
  );
  return Math.min(contentWidth, column.maxWidth ?? Number.POSITIVE_INFINITY);
}

function fitWidths(
  naturalWidths: readonly number[],
  columns: readonly TableColumn<unknown>[],
  availableWidth: number,
): number[] {
  const widths = [...naturalWidths];
  const floors = columns.map((column, index) =>
    Math.min(widths[index] ?? 0, Math.max(4, visibleWidth(column.header))),
  );

  while (widths.reduce((sum, width) => sum + width, 0) > availableWidth) {
    let candidate = -1;
    let largestSlack = 0;
    for (let index = 0; index < widths.length; index += 1) {
      const slack = (widths[index] ?? 0) - (floors[index] ?? 0);
      if (slack > largestSlack) {
        candidate = index;
        largestSlack = slack;
      }
    }
    if (candidate < 0) {
      break;
    }
    widths[candidate] = (widths[candidate] ?? 0) - 1;
  }

  return widths;
}

export function renderTable<Row>(
  rows: readonly Row[],
  columns: readonly TableColumn<Row>[],
  options: RenderTableOptions | number = {},
): string {
  if (columns.length === 0) {
    return "";
  }

  const normalizedOptions =
    typeof options === "number" ? { width: options } : options;
  const separator = normalizedOptions.separator ?? " │ ";
  const naturalWidths = columns.map((column) => columnWidth(rows, column));
  const separatorWidth = visibleWidth(separator) * (columns.length - 1);
  const availableWidth =
    normalizedOptions.width === undefined
      ? Number.POSITIVE_INFINITY
      : Math.max(columns.length * 4, normalizedOptions.width - separatorWidth);
  const widths = Number.isFinite(availableWidth)
    ? fitWidths(
        naturalWidths,
        columns as readonly TableColumn<unknown>[],
        availableWidth,
      )
    : naturalWidths;
  const renderCells = (cells: readonly string[]): string =>
    cells
      .map((cell, index) =>
        padRightVisible(truncateVisible(cell, widths[index] ?? 0), widths[index] ?? 0),
      )
      .join(separator);

  const header = renderCells(columns.map((column) => column.header));
  const divider = widths.map((width) => "─".repeat(width)).join("─┼─");
  const body = rows.map((row) => renderCells(columns.map((column) => column.value(row))));
  return [header, divider, ...body].join("\n");
}
