import { z } from "zod";
import { postgresUuidSchema } from "./identifiers";

// PostgreSQL accepts UUID-shaped identifiers regardless of their RFC version.
// Some long-lived/demo machine rows intentionally use deterministic identifiers
// such as 20000000-0000-0000-0000-000000000001, so machine references need the
// GUID validator rather than Zod's stricter RFC 9562 UUID validator.
export const assistantTurnRequestSchema = z
  .object({
    input: z.string().trim().min(1).max(2000),
    locale: z.enum(["en-ZA", "af-ZA"]),
    channel: z.enum(["typed", "voice"]),
    voiceCaptureId: z.uuid().optional(),
    supersedesVoiceCaptureIds: z.array(z.uuid()).min(1).max(5).optional(),
    sttConfidence: z.number().min(0).max(1).optional(),
    /**
     * The same utterance as other recognisers heard it (a second pass in the other
     * language, an AI transcriber). Never shown or stored as what was said; the server
     * uses them only to find the intent and the machine. See routing.ts.
     */
    alternatives: z
      .array(
        z.object({
          text: z.string().trim().min(1).max(2000),
          locale: z.enum(["en-ZA", "af-ZA"]),
          source: z.enum(["recogniser", "second-pass", "ai"]),
        }),
      )
      .max(4)
      .optional(),
    clarification: z
      .object({
        interactionId: z.uuid(),
        machineId: postgresUuidSchema.optional(),
        machineQuery: z.string().trim().min(1).max(160).optional(),
        description: z.string().trim().min(1).max(2000).optional(),
        urgency: z.enum(["can_work", "limping", "stopped"]).optional(),
        workPerformed: z.string().trim().max(2000).optional(),
        reading: z.number().min(0).optional(),
        readingDate: z.iso.date().optional(),
        serviceDate: z.iso.date().optional(),
      })
      .optional(),
  })
  .superRefine((value, context) => {
    if (value.alternatives?.length && value.channel !== "voice") {
      context.addIssue({
        code: "custom",
        path: ["alternatives"],
        message: "Only a spoken request has other hearings of it.",
      });
    }
    if (value.supersedesVoiceCaptureIds && value.channel !== "voice") {
      context.addIssue({
        code: "custom",
        path: ["supersedesVoiceCaptureIds"],
        message: "Only a voice request can supersede a voice capture.",
      });
    }
    if (value.supersedesVoiceCaptureIds && !value.voiceCaptureId) {
      context.addIssue({
        code: "custom",
        path: ["voiceCaptureId"],
        message: "A corrected voice request requires a fresh capture ID.",
      });
    }
    if (value.supersedesVoiceCaptureIds?.includes(value.voiceCaptureId ?? "")) {
      context.addIssue({
        code: "custom",
        path: ["voiceCaptureId"],
        message: "A corrected transcript cannot reuse the previous capture ID.",
      });
    }
    if (
      value.supersedesVoiceCaptureIds &&
      new Set(value.supersedesVoiceCaptureIds).size !== value.supersedesVoiceCaptureIds.length
    ) {
      context.addIssue({
        code: "custom",
        path: ["supersedesVoiceCaptureIds"],
        message: "Superseded capture IDs must be unique.",
      });
    }
    if (value.supersedesVoiceCaptureIds && value.clarification) {
      context.addIssue({
        code: "custom",
        path: ["supersedesVoiceCaptureIds"],
        message: "Capture supersession belongs only on the corrected base turn.",
      });
    }
  });

export type ParsedAssistantTurnRequest = z.infer<typeof assistantTurnRequestSchema>;
