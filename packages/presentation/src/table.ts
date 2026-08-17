import { padRightVisible, truncateVisible, visibleWidth } from "./text.js";

export interface TableColumn<Row> {
  readonly header: string;
  readonly value: (row: Row) => string;
  readonly minWidth?: number;
  readonly maxWidth?: number;
}

export interface RenderTableOptions {
  readonly separator?: string;
}

function columnWidth<Row>(rows: readonly Row[], column: TableColumn<Row>): number {
  const contentWidth = Math.max(
    visibleWidth(column.header),
    ...rows.map((row) => visibleWidth(column.value(row))),
    column.minWidth ?? 0,
  );
  return Math.min(contentWidth, column.maxWidth ?? Number.POSITIVE_INFINITY);
}

export function renderTable<Row>(
  rows: readonly Row[],
  columns: readonly TableColumn<Row>[],
  options: RenderTableOptions | number = {},
): string {
  if (columns.length === 0) {
    return "";
  }

  const separator =
    typeof options === "number" ? " │ " : (options.separator ?? " │ ");
  const widths = columns.map((column) => columnWidth(rows, column));
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
