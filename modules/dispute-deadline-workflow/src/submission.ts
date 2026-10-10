// A deterministic submission adapter simulator.
//
// It models four things that are specific to submitting into somebody else's
// deadline: that a late submission can succeed, that success is not delivery,
// that you usually get one attempt, and that a request which times out leaves
// you not knowing which of those happened.
//
// The late-but-accepted outcome is the one worth staring at. Stripe's Dispute
// object carries `evidence_details.past_due`, documented as "Whether the last
// evidence submission was submitted past the due date. Defaults to `false` if
// no evidence submissions have occurred. If `true`, then delivery of the
// latest evidence is *not* guaranteed." Submitting late is not an error. It
// returns, the case moves on, and the only trace is a boolean on an object
// nobody is looking at.

import type { Instant, Packet, SubmissionAttempt, SubmissionOutcome } from './types.ts';

export interface ProviderState {
  caseId: string;
  /** The provider's deadline, null when no response is permitted. */
  deadline: Instant | null;
  /** How many submissions the provider has already recorded. */
  submissionCount: number;
  /** Whether this provider accepts more than one submission. */
  allowsResubmission: boolean;
}

export interface SubmitRequest {
  packet: Packet;
  provider: ProviderState;
  sentAt: Instant;
  /** Injected transport behaviour. The simulator never decides this itself. */
  transport: 'OK' | 'TIMEOUT';
  attemptId: string;
}

export interface SubmitResult {
  attempt: SubmissionAttempt;
  provider: ProviderState;
  /** What the provider actually recorded, which the caller may not learn. */
  providerRecorded: boolean;
  note: string;
}

export function submit(request: SubmitRequest): SubmitResult {
  const { packet, provider, sentAt, transport, attemptId } = request;

  const base = {
    attemptId,
    caseId: packet.caseId,
    packetId: packet.packetId,
    manifestHash: packet.manifestHash,
    sentAt,
  };

  if (provider.deadline === null) {
    return {
      attempt: { ...base, outcome: 'REJECTED_NOT_PERMITTED', providerAckId: null },
      provider,
      providerRecorded: false,
      note: 'provider does not accept a response for this case',
    };
  }

  if (provider.submissionCount > 0 && !provider.allowsResubmission) {
    return {
      attempt: { ...base, outcome: 'REJECTED_ALREADY_SUBMITTED', providerAckId: null },
      provider,
      providerRecorded: false,
      note: 'provider records one submission per case',
    };
  }

  if (packet.entries.length === 0) {
    return {
      attempt: { ...base, outcome: 'REJECTED_VALIDATION', providerAckId: null },
      provider,
      providerRecorded: false,
      note: 'empty packet',
    };
  }

  const late = sentAt > provider.deadline;
  const recorded: ProviderState = {
    ...provider,
    submissionCount: provider.submissionCount + 1,
  };

  if (transport === 'TIMEOUT') {
    // The provider recorded the submission. We did not hear about it. This is
    // the case that makes a second attempt dangerous rather than free.
    return {
      attempt: { ...base, outcome: 'UNKNOWN_TIMEOUT', providerAckId: null },
      provider: recorded,
      providerRecorded: true,
      note: 'request timed out after the provider recorded the submission',
    };
  }

  const outcome: SubmissionOutcome = late
    ? 'ACCEPTED_LATE_DELIVERY_NOT_GUARANTEED'
    : 'ACCEPTED';
  return {
    attempt: { ...base, outcome, providerAckId: `ack-${attemptId}` },
    provider: recorded,
    providerRecorded: true,
    note: late
      ? 'accepted after the deadline; the provider does not guarantee delivery'
      : 'accepted before the deadline',
  };
}

/**
 * Whether an outcome is one the case can safely treat as finished.
 * `UNKNOWN_TIMEOUT` is deliberately absent: it is a state to resolve, not a
 * result to record.
 */
export function isSettled(outcome: SubmissionOutcome): boolean {
  return (
    outcome === 'ACCEPTED' ||
    outcome === 'ACCEPTED_LATE_DELIVERY_NOT_GUARANTEED' ||
    outcome === 'REJECTED_NOT_PERMITTED' ||
    outcome === 'REJECTED_ALREADY_SUBMITTED'
  );
}
