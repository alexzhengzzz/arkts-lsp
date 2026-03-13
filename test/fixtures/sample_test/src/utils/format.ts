export interface SampleUser {
  id: number;
  name: string;
}

export interface MetricSummary {
  label: string;
  value: string;
}

export const SAMPLE_USERS: SampleUser[] = [
  { id: 1, name: "Ada" },
  { id: 2, name: "Lin" },
  { id: 3, name: "Mina" },
];

export function shortLabel(name: string): string {
  return name.trim().slice(0, 8);
}

export function clampCount(value: number): number {
  return value < 0 ? 0 : value;
}

export function buildGreeting(userName: string, visitCount: number): string {
  return `Hello ${shortLabel(userName)}, visits=${clampCount(visitCount)}`;
}
