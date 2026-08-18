const csiPattern = /\u001B\[[0-?]*[ -/]*[@-~]/g;
const oscPattern = /\u001B\][^\u0007]*(?:\u0007|\u001B\\)/g;

export function stripAnsi(value: string): string {
  return value.replace(oscPattern, "").replace(csiPattern, "");
}

export function visibleWidth(value: string): number {
  return Array.from(stripAnsi(value)).length;
}

export function padRightVisible(value: string, width: number): string {
  return value + " ".repeat(Math.max(0, width - visibleWidth(value)));
}

export function truncateVisible(value: string, width: number): string {
  if (width <= 0) {
    return "";
  }
  if (visibleWidth(value) <= width) {
    return value;
  }
  if (width === 1) {
    return "…";
  }

  return Array.from(stripAnsi(value)).slice(0, width - 1).join("") + "…";
}

export function terminalWidth(width?: number): number {
  const resolved = width ?? process.stdout.columns ?? 80;
  return Math.max(40, Math.min(160, Math.floor(resolved)));
}

export function horizontalRule(width: number, character = "─"): string {
  return character.repeat(Math.max(0, width));
}
