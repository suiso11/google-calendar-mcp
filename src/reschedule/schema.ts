// M5 dedicated reschedule MCP: exact input schema for the ONLY tool.
//
// Tool: `reschedule-event` (the sole registered tool on this entrypoint).
// Editable fields: start / end ONLY. No title/description/attendee/create/
// delete fields exist; unknown keys are rejected (strictObject).
//
// Identity selection is exact + opaque: calendarId / eventId / account are
// non-empty opaque strings resolved hostside (never model-derived provider
// URLs). expectedEtag is the EXACT opaque source etag tied to the committed
// grant — never a fresh preflight substitution, never a hash/updated-only
// fallback (those are rejected before any patch).

import { z } from "zod";

/** Distinct MCP surface identity (never the readonly entrypoint). */
export const RESCHEDULE_MCP_NAME = "google-calendar-reschedule" as const;
export const RESCHEDULE_MCP_VERSION = "1.0.0-reschedule.1" as const;

/** The only tool on this dedicated entrypoint. */
export const RESCHEDULE_TOOL_NAME = "reschedule-event" as const;

const OpaqueIdSchema = z.string().min(1).max(512);
const AccountSchema = z.string().min(1).max(512);

/**
 * Strict RFC3339 instant grammar with real calendar validation (no
 * `Date.parse` rollover): `2023-02-30` is rejected instead of normalized to
 * March 2. Month lengths, leap years, time ranges, and numeric offsets are
 * enforced; `start < end` is still checked on the parsed instants.
 */
const ISO_INSTANT_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?(Z|[+-](\d{2}):(\d{2}))$/;

export function isStrictCalendarInstant(value: string): boolean {
  if (value.length === 0 || value.length > 128) return false;
  const m = ISO_INSTANT_PATTERN.exec(value);
  if (m === null) return false;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const hour = Number(m[4]);
  const minute = Number(m[5]);
  const second = m[6] === undefined ? 0 : Number(m[6]);
  const zone = m[8] ?? "";
  if (month < 1 || month > 12) return false;
  const leap =
    year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [
    31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31,
  ][month - 1] ?? 0;
  if (day < 1 || day > daysInMonth) return false;
  if (hour > 23 || minute > 59 || second > 59) return false;
  if (zone !== "Z") {
    const offHour = Number(m[9]);
    const offMinute = Number(m[10]);
    if (offHour > 23 || offMinute > 59) return false;
  }
  // Grammar + calendar are valid; the instant must also parse (fraction /
  // offset arithmetic) and preserve ordering at the call site.
  return !Number.isNaN(Date.parse(value));
}

/** Strict RFC3339-with-offset instant (explicit offset, no bare dates). */
const IsoInstantSchema = z
  .string()
  .min(1)
  .max(128)
  .refine(
    (value) => isStrictCalendarInstant(value),
    "start/end must be RFC3339 instants with an explicit offset",
  );

/**
 * Exact `reschedule-event` input: start/end fields ONLY plus the exact
 * opaque selection and the committed-grant etag. Strict: any extra key
 * (recurrence, title, description, attendees, …) is rejected.
 */
export const RescheduleEventInputSchema = z
  .strictObject({
    calendarId: OpaqueIdSchema,
    eventId: z.string().min(1).max(1024),
    account: AccountSchema.optional(),
    /** Intended start instant (strict RFC3339; provider owns grammar). */
    start: IsoInstantSchema,
    /** Intended end instant (strict RFC3339; must be after start). */
    end: IsoInstantSchema,
    /**
     * EXACT opaque source etag from the committed grant. Must be a real
     * etag: hash-only / updated-only expected revisions are rejected by the
     * caller before dispatch (no etag substitution, no fresh preflight).
     */
    expectedEtag: z.string().min(1).max(256),
  })
  .superRefine((value, ctx) => {
    const startMs = Date.parse(value.start);
    const endMs = Date.parse(value.end);
    if (Number.isNaN(startMs) || Number.isNaN(endMs) || !(endMs > startMs)) {
      ctx.addIssue({
        code: "custom",
        message: "start must be before end",
        path: ["start"],
      });
    }
  });

export type RescheduleEventInput = z.infer<typeof RescheduleEventInputSchema>;
