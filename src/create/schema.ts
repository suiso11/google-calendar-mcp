// M6 dedicated create MCP: exact input schema for the ONLY tool.
//
// Tool: `create-event` (the sole registered tool on this entrypoint).
// Editable fields: title/start/end ONLY (normal TIMED creation). No
// description/attendees/recurrence/all-day/delete/edit fields exist;
// unknown keys are rejected (strictObject).
//
// Identity selection is exact + opaque: calendarId / account are non-empty
// opaque strings resolved hostside (never model-derived). `id` is the
// host-derived stable insert id (32 lowercase hex from the immutable
// execution id, a strict subset of Google's base32hex alphabet) — never
// model input. start/end are strict RFC3339 instants with explicit offset;
// start < end is enforced.

import { z } from "zod";

/** Distinct MCP surface identity (never readonly/reschedule entrypoints). */
export const CREATE_MCP_NAME = "google-calendar-create" as const;
export const CREATE_MCP_VERSION = "1.0.0-create.1" as const;

/** The only tool on this dedicated entrypoint. */
export const CREATE_TOOL_NAME = "create-event" as const;

const OpaqueIdSchema = z.string().min(1).max(512);
const AccountSchema = z.string().min(1).max(512);

const ISO_INSTANT_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?(Z|[+-](\d{2}):(\d{2}))$/;

export function isStrictCreateInstant(value: string): boolean {
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
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth =
    [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1] ??
    0;
  if (day < 1 || day > daysInMonth) return false;
  if (hour > 23 || minute > 59 || second > 59) return false;
  if (zone !== "Z") {
    const offHour = Number(m[9]);
    const offMinute = Number(m[10]);
    if (offHour > 23 || offMinute > 59) return false;
  }
  return !Number.isNaN(Date.parse(value));
}

const IsoInstantSchema = z
  .string()
  .min(1)
  .max(128)
  .refine(
    (value) => isStrictCreateInstant(value),
    "start/end must be RFC3339 instants with an explicit offset",
  );

const CreateTitleSchema = z
  .string()
  .min(1)
  .max(256)
  .refine((value) => !value.includes("\0"), "title must not contain NUL")
  .refine((value) => value.trim().length > 0, "title must not be blank");

const StableEventIdSchema = z
  .string()
  .length(32)
  .regex(/^[0-9a-f]+$/, "stable event id must be 32 lowercase hex chars");

/**
 * Exact `create-event` input: opaque host selection + stable id + immutable
 * title + timed bounds ONLY. Strict: any extra key is rejected.
 */
export const CreateEventInputSchema = z
  .strictObject({
    calendarId: OpaqueIdSchema,
    account: AccountSchema.optional(),
    id: StableEventIdSchema,
    summary: CreateTitleSchema,
    start: IsoInstantSchema,
    end: IsoInstantSchema,
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

export type CreateEventInput = z.infer<typeof CreateEventInputSchema>;
