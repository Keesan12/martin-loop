export type MartinTone =
  | "brand"
  | "success"
  | "danger"
  | "warning"
  | "info"
  | "muted"
  | "plain";

export interface RenderEnvironment {
  readonly color?: "auto" | "always" | "never";
  readonly isTty?: boolean;
  readonly noColor?: boolean;
  readonly term?: string;
  readonly colorDepth?: number;
}

const escape = "\u001B[";

const basic = {
  reset: escape + "0m",
  bold: escape + "1m",
  dim: escape + "2m",
  brand: escape + "35m",
  success: escape + "32m",
  danger: escape + "31m",
  warning: escape + "33m",
  info: escape + "36m",
  muted: escape + "90m",
  plain: "",
} as const;

export const palette = {
  brand: [107, 85, 198],
  success: [94, 225, 115],
  danger: [255, 93, 93],
  warning: [244, 200, 74],
  info: [85, 199, 243],
  muted: [148, 163, 184],
  plain: [248, 250, 252],
} as const;

function rgb(red: number, green: number, blue: number): string {
  return escape + "38;2;" + red + ";" + green + ";" + blue + "m";
}

function resolveColorDepth(): number {
  const stream = process.stdout as NodeJS.WriteStream & {
    getColorDepth?: () => number;
  };

  try {
    return stream.getColorDepth?.() ?? 1;
  } catch {
    return 1;
  }
}

export function resolveColorEnabled(env: RenderEnvironment = {}): boolean {
  if (env.color === "always") {
    return true;
  }
  if (env.color === "never") {
    return false;
  }

  const noColor =
    env.noColor ?? Object.prototype.hasOwnProperty.call(process.env, "NO_COLOR");
  if (noColor) {
    return false;
  }

  const term = env.term ?? process.env.TERM;
  if (term === "dumb") {
    return false;
  }

  return env.isTty ?? process.stdout.isTTY === true;
}

function toneCode(tone: MartinTone, env: RenderEnvironment): string {
  if (tone === "plain") {
    return "";
  }

  const depth = env.colorDepth ?? resolveColorDepth();
  if (depth >= 24) {
    const [red, green, blue] = palette[tone];
    return rgb(red, green, blue);
  }

  return basic[tone];
}

export function paint(
  value: string,
  tone: MartinTone,
  env: RenderEnvironment = {},
): string {
  if (!resolveColorEnabled(env) || tone === "plain") {
    return value;
  }

  return toneCode(tone, env) + value + basic.reset;
}

export function bold(value: string, env: RenderEnvironment = {}): string {
  return resolveColorEnabled(env) ? basic.bold + value + basic.reset : value;
}

export function dim(value: string, env: RenderEnvironment = {}): string {
  return resolveColorEnabled(env) ? basic.dim + value + basic.reset : value;
}

export const terminalAnsi = {
  reset: basic.reset,
  hideCursor: escape + "?25l",
  showCursor: escape + "?25h",
  eraseLine: escape + "2K",
  cursorHome: "\r",
  rgb,
} as const;
