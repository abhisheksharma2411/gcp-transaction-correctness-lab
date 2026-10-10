// Deterministic fixtures and scenarios, shared by the tests and the report.
//
// Every instant here is a literal. Nothing reads a clock.

import type { EvidenceItem, Instant, ProviderNotification } from './types.ts';
import { contentDigest } from './manifest.ts';

export function at(iso: string): Instant {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) throw new Error(`fixture: unparseable instant ${iso}`);
  return ms;
}

export function seconds(iso: string): number {
  return Math.floor(at(iso) / 1000);
}

export interface NotificationOptions {
  providerCaseId: string;
  deliveryId: string;
  paymentRef?: string;
  amountMinor?: number;
  currency?: string;
  reasonCode?: string;
  raisedAt: string;
  receivedAt?: string;
  dueBySeconds: number | null;
}

export function notification(options: NotificationOptions): ProviderNotification {
  return {
    providerCaseId: options.providerCaseId,
    deliveryId: options.deliveryId,
    paymentRef: options.paymentRef ?? `pay-${options.providerCaseId}`,
    amountMinor: options.amountMinor ?? 48_900,
    currency: options.currency ?? 'USD',
    reasonCode: options.reasonCode ?? 'provider-reason-14',
    raisedAt: at(options.raisedAt),
    receivedAt: at(options.receivedAt ?? options.raisedAt),
    dueBySeconds: options.dueBySeconds,
  };
}

export interface EvidenceOptions {
  itemId: string;
  caseId: string;
  kind: string;
  body: string;
  capturedAt: string;
  classification?: EvidenceItem['classification'];
  origin?: EvidenceItem['origin'];
  redactionProfile?: string;
  sourceSystem?: string;
}

export function evidence(options: EvidenceOptions): EvidenceItem {
  return {
    itemId: options.itemId,
    caseId: options.caseId,
    kind: options.kind,
    contentHash: contentDigest(options.body),
    capturedAt: at(options.capturedAt),
    sourceSystem: options.sourceSystem ?? 'order-service',
    classification: options.classification ?? 'INTERNAL',
    redactionProfile: options.redactionProfile ?? 'NONE',
    origin: options.origin ?? 'SYSTEM_EXPORT',
  };
}

// ---------------------------------------------------------------------------
// The deadline fixture table
// ---------------------------------------------------------------------------

export interface DeadlineFixture {
  id: string;
  what: string;
  notification: ProviderNotification;
  ruleVersion: string;
  zoneTableVersion: string;
  /** What this fixture is here to demonstrate. */
  covers: string;
}

export const DEADLINE_FIXTURES: DeadlineFixture[] = [
  {
    id: 'D01',
    what: 'the provider supplies a deadline',
    notification: notification({
      providerCaseId: 'dp-1001',
      deliveryId: 'dl-1',
      raisedAt: '2026-10-05T14:20:00Z',
      dueBySeconds: seconds('2026-10-26T03:59:59Z'),
    }),
    ruleVersion: 'disputes-2026.1',
    zoneTableVersion: 'synthetic-2026e',
    covers: 'the supplied instant is taken as stated and no rule arithmetic runs',
  },
  {
    id: 'D02',
    what: 'the provider supplies nothing and the window is derived',
    notification: notification({
      providerCaseId: 'dp-1002',
      deliveryId: 'dl-1',
      raisedAt: '2026-11-20T19:05:00Z',
      dueBySeconds: null,
    }),
    ruleVersion: 'disputes-2026.1',
    zoneTableVersion: 'synthetic-2026e',
    covers: 'a business-day walk across a weekend and two consecutive holidays',
  },
  {
    id: 'D03',
    what: 'the zero sentinel',
    notification: notification({
      providerCaseId: 'dp-1003',
      deliveryId: 'dl-1',
      raisedAt: '2026-10-05T14:20:00Z',
      dueBySeconds: 0,
    }),
    ruleVersion: 'disputes-2026.1',
    zoneTableVersion: 'synthetic-2026e',
    covers: 'a due_by of zero means no response is permitted, not 1 January 1970',
  },
  {
    id: 'D04',
    what: 'a cutoff before the clocks go back',
    notification: notification({
      providerCaseId: 'dp-1004',
      deliveryId: 'dl-1',
      raisedAt: '2026-10-23T13:00:00Z',
      dueBySeconds: null,
    }),
    ruleVersion: 'disputes-2026.1',
    zoneTableVersion: 'synthetic-2026e',
    covers: '17:00 New York while daylight saving is still in force',
  },
  {
    id: 'D05',
    what: 'the same cutoff after the clocks go back',
    notification: notification({
      providerCaseId: 'dp-1005',
      deliveryId: 'dl-1',
      raisedAt: '2026-10-27T13:00:00Z',
      dueBySeconds: null,
    }),
    ruleVersion: 'disputes-2026.1',
    zoneTableVersion: 'synthetic-2026e',
    covers: 'the identical local cutoff, one hour later in UTC',
  },
  {
    id: 'D06',
    what: 'Winnipeg under the older zone table',
    notification: notification({
      providerCaseId: 'dp-1006',
      deliveryId: 'dl-1',
      raisedAt: '2026-10-28T13:00:00Z',
      dueBySeconds: null,
    }),
    ruleVersion: 'disputes-ca-2026.1',
    zoneTableVersion: 'synthetic-2026d',
    covers: 'the zone returns to -06:00 on 1 November',
  },
  {
    id: 'D07',
    what: 'Winnipeg under the newer zone table',
    notification: notification({
      providerCaseId: 'dp-1007',
      deliveryId: 'dl-1',
      raisedAt: '2026-10-28T13:00:00Z',
      dueBySeconds: null,
    }),
    ruleVersion: 'disputes-ca-2026.1',
    zoneTableVersion: 'synthetic-2026e',
    covers: 'the zone stays at -05:00; one identical input, a different deadline',
  },
  {
    id: 'D08',
    what: 'a thirty-minute daylight shift',
    notification: notification({
      providerCaseId: 'dp-1008',
      deliveryId: 'dl-1',
      raisedAt: '2026-09-30T02:00:00Z',
      dueBySeconds: null,
    }),
    ruleVersion: 'disputes-lhi-2026.1',
    zoneTableVersion: 'synthetic-2026e',
    covers: 'Lord Howe Island moves by half an hour, not a whole one',
  },
  {
    id: 'D09',
    what: 'a Friday weekend',
    notification: notification({
      providerCaseId: 'dp-1009',
      deliveryId: 'dl-1',
      raisedAt: '2026-11-02T06:00:00Z',
      dueBySeconds: null,
    }),
    ruleVersion: 'disputes-gulf-2026.1',
    zoneTableVersion: 'synthetic-2026e',
    covers: 'the weekend mask is data; Saturday is a working day here',
  },
  {
    id: 'D10',
    what: 'a notification that arrives after its own deadline',
    notification: notification({
      providerCaseId: 'dp-1010',
      deliveryId: 'dl-1',
      raisedAt: '2026-10-05T14:20:00Z',
      receivedAt: '2026-10-28T09:00:00Z',
      dueBySeconds: seconds('2026-10-20T03:59:59Z'),
    }),
    ruleVersion: 'disputes-2026.1',
    zoneTableVersion: 'synthetic-2026e',
    covers: 'a case that is past its deadline at the instant it is created',
  },
  {
    id: 'D11',
    what: 'the later rule set applied to the same notification as D02',
    notification: notification({
      providerCaseId: 'dp-1011',
      deliveryId: 'dl-1',
      raisedAt: '2026-11-20T19:05:00Z',
      dueBySeconds: null,
    }),
    ruleVersion: 'disputes-2026.2',
    zoneTableVersion: 'synthetic-2026e',
    covers: 'seven business days against a calendar with one more shutdown day',
  },
  {
    id: 'D12',
    what: 'a deadline beyond the platform scheduling horizon',
    notification: notification({
      providerCaseId: 'dp-1012',
      deliveryId: 'dl-1',
      raisedAt: '2026-10-05T14:20:00Z',
      dueBySeconds: seconds('2026-12-18T04:59:59Z'),
    }),
    ruleVersion: 'disputes-2026.1',
    zoneTableVersion: 'synthetic-2026e',
    covers: 'more than thirty days out, so one task cannot reach it',
  },
];

// ---------------------------------------------------------------------------
// The Manitoba case
// ---------------------------------------------------------------------------

/**
 * A deadline whose local cutoff falls after the instant at which the zone's
 * rules changed. Run under the two pinned tables it produces two different
 * instants from one identical input. Modelled on IANA Time Zone Database
 * release 2026e: "Manitoba moves to permanent -05 on 2026-10-31."
 */
export const MANITOBA_CASE = {
  zone: 'America/Winnipeg',
  civil: { year: 2026, month: 11, day: 4, minutes: 17 * 60 },
};
