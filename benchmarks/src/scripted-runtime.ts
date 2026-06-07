export function roundUsd(value: number): number {
  return Number(value.toFixed(2));
}

export function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}
