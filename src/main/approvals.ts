/**
 * Native approvals — the permission boundary surfaced in the window
 * (desktop-blueprint.md §6, core §9.5).
 *
 * The main process supplies `onApproval` to `createCore` (every session is
 * interactive, §6). A gated action blocks the turn until the user answers. The
 * app DECIDES NOTHING: it routes the core's `PendingApproval` to the focused
 * window's renderer and returns the `ApprovalResponse` the renderer produces.
 * The request is relayed VERBATIM — the core masks secrets before it leaves the
 * process (core §10.10), so the dialog shows the authoritative, already-masked
 * action; the app never reconstructs or un-masks a value (invariant §11.2#3).
 *
 * The broker correlates each request by `id`: it pushes the request to the
 * renderer over the event channel and parks a promise the renderer resolves by
 * invoking the resolve op. This keeps the round-trip entirely over the
 * two-primitive bridge (§1.2) — no extra channel, no Node in the renderer.
 */
import type { ApprovalResponse, PendingApproval } from "@voidrift/core";
import { z } from "zod";

/** The event frame type the renderer listens for to raise the dialog (§6.1). */
export const APPROVAL_EVENT = "APPROVAL_REQUESTED";

/** The Zod schema validating the renderer's returned decision (§6.1). */
const approvalResponseSchema = z
  .object({
    requestId: z.string().min(1),
    decision: z.enum(["approve", "edit", "reject"]),
    editedArgs: z.record(z.string(), z.unknown()).optional(),
    remember: z.enum(["session", "project"]).optional(),
    chosenPattern: z.string().optional(),
  })
  .strict();

/** Validate a renderer-supplied approval decision; null if malformed (§6.1). */
export function parseApprovalResponse(raw: unknown): ApprovalResponse | null {
  const parsed = approvalResponseSchema.safeParse(raw);
  if (!parsed.success) return null;
  return parsed.data as ApprovalResponse;
}

/** How the broker reaches the focused window's renderer (§6.1). */
export interface ApprovalTransport {
  /** Push the full, already-masked `PendingApproval` to the renderer. */
  present(req: PendingApproval): void;
}

/**
 * Routes `onApproval` to the renderer and resolves on the renderer's decision.
 * One broker per embedded core; it correlates concurrent fan-out asks by `id`.
 */
export class ApprovalBroker {
  private readonly pending = new Map<string, (r: ApprovalResponse) => void>();

  constructor(private readonly transport: ApprovalTransport) {}

  /** The `onApproval` handler passed to `createCore` (core §2.1, §2.5). */
  readonly onApproval = (req: PendingApproval): Promise<ApprovalResponse> => {
    // Present the FULL action (tool, args, diff) verbatim — never reconstructed
    // or un-masked (§6.1, invariant §11.2#3).
    this.transport.present(req);
    return new Promise<ApprovalResponse>((resolve) => {
      this.pending.set(req.id, resolve);
    });
  };

  /**
   * The renderer's decision arrives here (via a dedicated invoke op). It is
   * validated, correlated to its parked request by `requestId`, and resolves
   * the turn. An unknown or malformed decision is ignored (the turn stays
   * blocked until a valid answer, or the core's timeout denies, §6.3).
   */
  resolve(raw: unknown): boolean {
    const response = parseApprovalResponse(raw);
    if (!response) return false;
    const settle = this.pending.get(response.requestId);
    if (!settle) return false;
    this.pending.delete(response.requestId);
    settle(response);
    return true;
  }

  /** Pending request count (for teardown assertions). */
  get size(): number {
    return this.pending.size;
  }
}
