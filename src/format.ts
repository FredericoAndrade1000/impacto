// How the page writes what it tells: a count, a way across the field, a colour.
// Reuse the formatters across the HUD, inspectors and catalogues.
import { locale } from './i18n.ts';
const formats = new Map<string, Intl.NumberFormat>();
export function number(value: unknown, digits = 1): string {
  const key = `${locale()}:${digits}`;
  let format = formats.get(key);
  if (!format) { format = new Intl.NumberFormat(locale(), { maximumFractionDigits: digits }); formats.set(key, format); }
  const finite = Number(value ?? 0);
  return Number.isFinite(finite) ? format.format(Math.abs(finite) < .5 * 10 ** -digits ? 0 : finite) : '—';
}
// A whole number in the words of the page: 12.345.
export const count = (value: unknown): string => number(value, 0);
export function compactNumber(value: number | bigint, long = false): string {
  const key = `${locale()}:compact:${long}`;
  let format = formats.get(key);
  if (!format) { format = new Intl.NumberFormat(locale(), { notation: 'compact', compactDisplay: long ? 'long' : 'short', maximumFractionDigits: 1 }); formats.set(key, format); }
  return format.format(value);
}
export const metres = (value: unknown): string => count(value) + ' m';
export const kilometres = (value: unknown): string => number(value) + ' km';
export const distance = (value: number): string => Math.abs(value) >= 1000 ? kilometres(value / 1000) : metres(value);
export const speed = (metresPerSecond: number): string => number(Math.abs(metresPerSecond) * 3.6) + ' km/h';
export const volume = (value: number): string => number(value, value > 0 && value < .1 ? 2 : 1) + ' m³';
export const litres = (value: unknown): string => count(value) + ' L';
// Mechanical hp: NIST SP 811, Appendix B.8 (1 hp ≈ 745.6999 W).
// https://www.nist.gov/pml/special-publication-811/nist-guide-si-appendix-b-conversion-factors/nist-guide-si-appendix-b8
export const horsepower = (powerKw: number): number => powerKw / .7456998715822702;
export const power = (powerKw: number): string => count(horsepower(powerKw)) + ' hp';
// What a thruster pushes with, in kilonewtons.
export const thrust = (newtons: number): string => number(newtons / 1000) + ' kN';
export const specificPower = (powerKw: number, tonnes: number): string => number(horsepower(powerKw) / Math.max(.001, tonnes)) + ' hp/t';
// Which way from `from` a place at `x` lies.
export const way = (x: number, from: number): '←' | '→' => x < from ? '←' : '→';
// A colour (0xrrggbb) as CSS writes it.
export const hex = (colour: number): string => '#' + colour.toString(16).padStart(6, '0');
