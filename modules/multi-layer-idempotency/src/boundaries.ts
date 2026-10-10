// The six boundaries, and the de-duplication each one offers before the
// operation contract is ever consulted.
//
// Every one of these is a real mechanism with real limits, and the limits are
// the interesting part. Each class below names what it does not cover.

import { taskId as deriveTaskId } from "./fingerprint.ts";
import type { OperationProcessor, SubmitResult } from "./processor.ts";
import type { OperationContext } from "./types.ts";

/**
 * A transactional inbox.
 *
 * Records that a message id has been seen, in the same transaction as the work.
 * This is what Pub/Sub's documentation is asking for when it says to "use the
 * information about the progress of processing a message to prevent duplicate
 * work when an acknowledgment fails."
 *
 * What it does not cover: publish-side duplicates. The same payload published
 * twice arrives with two different message ids, and this table sees two
 * different messages. The operation contract below it is what catches those.
 */
export class TransactionalInbox {
  readonly #seen = new Set<string>();
  #suppressed = 0;

  deliver(
    messageId: string,
    ctx: OperationContext,
    processor: OperationProcessor,
    nowMs: number,
  ): SubmitResult | "ALREADY_PROCESSED" {
    if (this.#seen.has(messageId)) {
      this.#suppressed += 1;
      return "ALREADY_PROCESSED";
    }
    const result = processor.submit(ctx, nowMs);
    // Recorded after the work, in the same transaction a real implementation
    // would use. A crash between the two is the redelivery case, and the
    // operation contract is what makes that safe.
    this.#seen.add(messageId);
    return result;
  }

  /** Redelivery after the side effect but before the acknowledgement landed. */
  deliverWithLostAck(
    messageId: string,
    ctx: OperationContext,
    processor: OperationProcessor,
    nowMs: number,
  ): SubmitResult {
    const result = processor.submit(ctx, nowMs);
    // The ack failed, so the inbox row was never committed. Pub/Sub will send
    // this message again, and it will look entirely new to this layer.
    return result;
  }

  get suppressedCount(): number {
    return this.#suppressed;
  }
}

export class TaskAlreadyExists extends Error {
  readonly taskId: string;
  constructor(taskId: string) {
    super(`task ${taskId} already exists`);
    this.taskId = taskId;
  }
}

/**
 * A queue that de-duplicates on task name.
 *
 * Cloud Tasks documents that "explicitly specifying a task ID enables task
 * de-duplication" and that a repeat fails with ALREADY_EXISTS. It also
 * documents the limit this class models: names are not reusable immediately,
 * and the window is finite -- "up to 24 hours (or 9 days if the task's queue
 * was created using a queue.yaml or queue.xml)".
 *
 * So this is de-duplication with an expiry date, which is exactly why it cannot
 * be the only layer.
 */
export class DeduplicatingQueue {
  readonly #tombstones = new Map<string, number>();
  #rejected = 0;

  readonly windowMs: number;

  constructor(windowMs: number) {
    this.windowMs = windowMs;
  }

  /** @throws TaskAlreadyExists when the name is still held. */
  enqueue(operationId: string, step: string, nowMs: number): string {
    const id = deriveTaskId(operationId, step);
    const held = this.#tombstones.get(id);
    if (held !== undefined && nowMs - held < this.windowMs) {
      this.#rejected += 1;
      throw new TaskAlreadyExists(id);
    }
    this.#tombstones.set(id, nowMs);
    return id;
  }

  /** True when the name has aged out and would be accepted again. */
  wouldAccept(operationId: string, step: string, nowMs: number): boolean {
    const id = deriveTaskId(operationId, step);
    const held = this.#tombstones.get(id);
    return held === undefined || nowMs - held >= this.windowMs;
  }

  get rejectedCount(): number {
    return this.#rejected;
  }
}

/**
 * An orchestrator that retries a step.
 *
 * The thing that matters is what the retry carries. A step that regenerates its
 * operation id on retry has produced a second operation; a step that propagates
 * the id it was given has produced a second copy of the first one. The
 * difference is one line of code and one duplicated effect.
 */
export class RetryingWorkflow {
  #stepAttempts = 0;

  /**
   * @param regenerateId models the mistake: a fresh id per attempt.
   */
  runStep(
    ctx: OperationContext,
    processor: OperationProcessor,
    nowMs: number,
    opts: { attempts: number; regenerateId?: boolean },
  ): SubmitResult[] {
    const results: SubmitResult[] = [];
    for (let i = 0; i < opts.attempts; i += 1) {
      this.#stepAttempts += 1;
      const carried: OperationContext = opts.regenerateId
        ? { ...ctx, operationId: `${ctx.operationId}-attempt-${i}`, origin: "workflow", attempt: i + 1 }
        : { ...ctx, origin: "workflow", attempt: i + 1 };
      results.push(processor.submit(carried, nowMs + i));
    }
    return results;
  }

  get stepAttempts(): number {
    return this.#stepAttempts;
  }
}

/**
 * An inbound webhook from the provider.
 *
 * Providers resend. The event id is the provider's identity for the
 * notification, which is not the same thing as our identity for the operation
 * -- two different events can describe one operation, and the same event can
 * arrive twice.
 */
export class WebhookEndpoint {
  readonly #seenEvents = new Set<string>();
  #suppressed = 0;

  receive(
    eventId: string,
    ctx: OperationContext,
    processor: OperationProcessor,
    nowMs: number,
  ): SubmitResult | "DUPLICATE_EVENT" {
    if (this.#seenEvents.has(eventId)) {
      this.#suppressed += 1;
      return "DUPLICATE_EVENT";
    }
    this.#seenEvents.add(eventId);
    return processor.submit({ ...ctx, origin: "provider" }, nowMs);
  }

  get suppressedCount(): number {
    return this.#suppressed;
  }
}

/**
 * Operator and disaster-recovery replay.
 *
 * The boundary with no de-duplication of its own, by construction: a human has
 * decided to re-run something. Everything that stops a replay from duplicating
 * an effect is below this line, which makes replay the honest test of whether
 * the layers underneath actually work.
 */
export function operatorReplay(
  ctx: OperationContext,
  processor: OperationProcessor,
  nowMs: number,
): SubmitResult {
  return processor.submit({ ...ctx, origin: "replay" }, nowMs);
}
