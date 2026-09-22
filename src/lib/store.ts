/**
 * Async data-access layer backed by Supabase (PostgREST).
 *
 * This replaces the old better-sqlite3 file DB. Every call is async and hits
 * the shared Postgres database, so all Vercel lambda instances see the same
 * data and writes persist.
 *
 * Column names match the original SQLite schema exactly (see supabase/schema.sql),
 * so this file is the ONLY place that knows how filters/limits are written.
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

/** Local-wall-clock ISO "YYYY-MM-DD HH:MM:SS" used for timestamps. */
export function nowSql(d: Date = new Date()): string {
  return d.toISOString().replace("T", " ").slice(0, 19);
}

let client: SupabaseClient | null = null;

export function supabase(): SupabaseClient {
  if (client) return client;
  const url =
    process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.PLEXUS_SUPABASE_URL || "";
  const anon =
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || process.env.PLEXUS_SUPABASE_KEY || "";
  // Service role bypasses RLS. It's only safe server-side (never exposed to the
  // browser). Prefer it whenever present.
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || anon;
  if (!url || !key) {
    throw new Error("Supabase is not configured (NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY)");
  }
  client = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return client;
}

type Prim = string | number | boolean | null;
export interface RangeCond {
  gt?: number | string;
  gte?: number | string;
  lt?: number | string;
  lte?: number | string;
  neq?: Prim;
  in?: Prim[];
  is?: null;
}
export type WhereValue = Prim | RangeCond;
export type Where = Record<string, WhereValue | undefined>;
export interface OrderOpt {
  order?: string;
  asc?: boolean;
  limit?: number;
}

// Loose structural type for the PostgREST filter/order chain. Casting through
// it keeps the implementation stable across @supabase/supabase-js versions.
interface Chain {
  eq(...args: unknown[]): unknown;
  neq(...args: unknown[]): unknown;
  gt(...args: unknown[]): unknown;
  gte(...args: unknown[]): unknown;
  lt(...args: unknown[]): unknown;
  lte(...args: unknown[]): unknown;
  is(...args: unknown[]): unknown;
  in(...args: unknown[]): unknown;
  order(...args: unknown[]): unknown;
  limit(...args: unknown[]): unknown;
}

function chain(q: unknown): Chain {
  return q as Chain;
}

function applyOrd(q: Chain, opts: OrderOpt): void {
  if (opts.order) chain(chain(q).order(opts.order, { ascending: opts.asc ?? true }));
  if (opts.limit) chain(q).limit(opts.limit);
}

function applyWhere(q: Chain, where: Where): void {
  for (const [col, cond] of Object.entries(where)) {
    if (cond === undefined || cond === null) {
      chain(q).is(col, null);
    } else if (typeof cond === "object") {
      if ("gt" in cond) chain(q).gt(col, cond.gt as any);
      if ("gte" in cond) chain(q).gte(col, cond.gte as any);
      if ("lt" in cond) chain(q).lt(col, cond.lt as any);
      if ("lte" in cond) chain(q).lte(col, cond.lte as any);
      if ("neq" in cond) chain(q).neq(col, cond.neq as any);
      if ("in" in cond && Array.isArray(cond.in)) chain(q).in(col, cond.in as any);
      if ("is" in cond) chain(q).is(col, cond.is);
    } else {
      chain(q).eq(col, cond as any);
    }
  }
}

function newError(table: string, error: any): Error {
  return new Error(`${table}: ${error?.message || String(error)}`);
}

/** SELECT many. */
export async function rows<T = any>(table: string, where: Where = {}, opts: OrderOpt = {}): Promise<T[]> {
  const q = supabase().from(table).select("*");
  applyWhere(q as any, where);
  applyOrd(q as any, opts);
  const { data, error } = await q;
  if (error) throw newError(table, error);
  return (data ?? []) as T[];
}

/** SELECT one that must match the where (returns null when no row). */
export async function row<T = any>(table: string, where: Where): Promise<T | null> {
  const q = supabase().from(table).select("*");
  applyWhere(q as any, where);
  const { data, error } = await q.maybeSingle();
  if (error) throw newError(table, error);
  return data as T | null;
}

/** SELECT by primary key `id`. */
export async function byId<T = any>(table: string, id: number | string): Promise<T | null> {
  return row<T>(table, { id });
}

/** INSERT and return the inserted row (id is generated server-side). */
export async function insertRow<T = any>(table: string, data: Record<string, unknown>): Promise<T> {
  const { data: inserted, error } = await supabase().from(table).insert(data).select("*").single();
  if (error) throw newError(table, error);
  return inserted as T;
}

/** INSERT many rows; returns nothing (rows keep DB-generated ids). */
export async function insertMany(table: string, data: Record<string, unknown>[]): Promise<void> {
  const { error } = await supabase().from(table).insert(data);
  if (error) throw newError(table, error);
}

/**
 * INSERT ... ON CONFLICT UPDATE.
 * `onConflict` must be a Postgres column list, e.g. "key_id,model,day,hour".
 */
export async function upsertRows(table: string, data: Record<string, unknown>[], onConflict: string): Promise<void> {
  const { error } = await supabase().from(table).upsert(data, { onConflict });
  if (error) throw newError(table, error);
}

/** UPDATE by primary key `id`. */
export async function updateRow(table: string, id: number | string, data: Record<string, unknown>): Promise<void> {
  const { error } = await supabase().from(table).update(data).eq("id", id);
  if (error) throw newError(table, error);
}

/** UPDATE zero-or-more rows matching `where`. */
export async function updateRows(table: string, where: Where, data: Record<string, unknown>): Promise<void> {
  const q = supabase().from(table).update(data);
  applyWhere(q as any, where);
  const { error } = await q;
  if (error) throw newError(table, error);
}

/** DELETE rows matching `where` (all rows when `where` is empty). */
export async function deleteRows(table: string, where: Where = {}): Promise<void> {
  const q = supabase().from(table).delete();
  applyWhere(q as any, where);
  const { error } = await q;
  if (error) throw newError(table, error);
}

/** COUNT matching rows. */
export async function countRows(table: string, where: Where = {}): Promise<number> {
  const q = supabase().from(table).select("*", { count: "exact" });
  applyWhere(q as any, where);
  const { data, error } = await q;
  if (error) throw newError(table, error);
  return Array.isArray(data) ? data.length : 0;
}

/** Set `updated_at = now` for a row. */
export function touch(table: string, id: number): Promise<void> {
  return updateRow(table, id, { updated_at: nowSql() });
}

export interface TzParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  weekday: number;
}

export function tzParts(tz: string, d: Date = new Date()): TzParts {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23",
  });
  const parts: Record<string, string> = {};
  for (const p of fmt.formatToParts(d)) if (p.type !== "literal") parts[p.type] = p.value;
  const year = +parts.year;
  const month = +parts.month;
  const day = +parts.day;
  const hour = +parts.hour;
  return { year, month, day, hour, weekday: new Date(Date.UTC(year, month - 1, day)).getUTCDay() };
}

export function dayKeyFromParts(p: TzParts): string {
  return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
}

export function dayKey(tz: string, d: Date = new Date()): string {
  return dayKeyFromParts(tzParts(tz, d));
}

export function addDays(day: string, n: number): string {
  const [y, m, d] = day.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + n));
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, "0")}-${String(dt.getUTCDate()).padStart(2, "0")}`;
}

export function monthStartKey(tz: string, d: Date = new Date()): string {
  const p = tzParts(tz, d);
  return `${p.year}-${String(p.month).padStart(2, "0")}-01`;
}

// Most recent local date whose weekday == resetDay (0=Sun .. 6=Sat).
export function weekStartKey(tz: string, resetDay: number, d: Date = new Date()): string {
  let key = dayKey(tz, d);
  let parts = tzParts(tz, d);
  while (parts.weekday !== resetDay) {
    key = addDays(key, -1);
    parts = tzPartsOfString(key);
  }
  return key;
}

function tzPartsOfString(day: string): TzParts {
  const [y, m, d] = day.split("-").map(Number);
  return { year: y, month: m, day: d, hour: 0, weekday: new Date(Date.UTC(y, m - 1, d)).getUTCDay() };
}