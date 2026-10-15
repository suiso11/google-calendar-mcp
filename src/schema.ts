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
 * Exact `reschedule-event` input: start/end fields ONLY plus the exact
 * opaque selection and the committed-grant etag. Strict: any extra key
 * (recurrence, title, description, attendees, …) is rejected.
 */
export const RescheduleEventInputSchema = z
  .strictObject({
    calendarId: OpaqueIdSchema,
    eventId: z.string().min(1).max(1024),
    account: AccountSchema.optional(),
    /** Intended start instant (opaque here; provider owns instant grammar). */
    start: z.string().min(1).max(128),
    /** Intended end instant (opaque here; provider owns instant grammar). */
    end: z.string().min(1).max(128),
    /**
     * EXACT opaque source etag from the committed grant. Must be a real
     * etag: hash-only / updated-only expected revisions are rejected by the
     * caller before dispatch (no etag substitution, no fresh preflight).
     */
    expectedEtag: z.string().min(1).max(256),
  })
  .superRefine((value, ctx) => {
    if (value.start === value.end) {
      ctx.addIssue({
        code: "custom",
        message: "start must be before end",
        path: ["start"],
      });
    }
  });

export type RescheduleEventInput = z.infer<typeof RescheduleEventInputSchema>;

/** Canonical JSON input schema (for binding-identity hashing). */
export function rescheduleInputJsonSchema(): Record<string, unknown> {
  return {
    type: "object",
    properties: {
      calendarId: { type: "string", minLength: 1, maxLength: 512 },
      eventId: { type: "string", minLength: 1, maxLength: 1024 },
      account: { type: "string", minLength: 1, maxLength: 512 },
      start: { type: "string", minLength: 1, maxLength: 128 },
      end: { type: "string", minLength: 1, maxLength: 128 },
      expectedEtag: { type: "string", minLength: 1, maxLength: 256 },
    },
    required: ["calendarId", "eventId", "start", "end", "expectedEtag"],
    additionalProperties: false,
  };
}
