import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { approve, diffPackets, entriesOf, manifestHash, reproduce } from '../src/manifest.ts';
import { computeDeadline, ruleSetByVersion } from '../src/deadline.ts';
import { at, evidence, notification, seconds } from '../src/scenarios.ts';
import type { Packet } from '../src/types.ts';

const DECISION = computeDeadline({
  notification: notification({
    providerCaseId: 'dp-m1',
    deliveryId: 'dl-1',
    raisedAt: '2026-10-05T09:00:00Z',
    dueBySeconds: seconds('2026-10-26T03:59:59Z'),
  }),
  rules: ruleSetByVersion('disputes-2026.1'),
  zoneTableVersion: 'synthetic-2026e',
});

const RECEIPT = evidence({ itemId: 'i-receipt', caseId: 'c-1', kind: 'receipt', body: 'original', capturedAt: '2026-10-06T10:00:00Z' });
const DELIVERY = evidence({ itemId: 'i-delivery', caseId: 'c-1', kind: 'delivery', body: 'carrier proof', capturedAt: '2026-10-06T11:00:00Z' });
const SIGNED = evidence({ itemId: 'i-receipt', caseId: 'c-1', kind: 'receipt', body: 'signed copy', capturedAt: '2026-10-07T10:00:00Z' });

function approveWith(items: typeof RECEIPT[], existing: Packet[], actor = 'approver-okafor', reason = 'reviewed') {
  return approve({
    caseId: 'c-1',
    items,
    decision: DECISION,
    approvedBy: actor,
    approvedAt: at('2026-10-07T15:00:00Z'),
    approvalReason: reason,
    existing,
  });
}

test('manifest: collection order does not change the hash', () => {
  const forward = manifestHash('c-1', entriesOf([RECEIPT, DELIVERY]), 'r', 'PROVIDER_SUPPLIED');
  const reverse = manifestHash('c-1', entriesOf([DELIVERY, RECEIPT]), 'r', 'PROVIDER_SUPPLIED');
  assert.equal(forward, reverse);
});

test('manifest: replacing a document produces a new packet version', () => {
  const first = approveWith([RECEIPT, DELIVERY], []);
  assert.ok(first.ok && first.created);
  const packets = first.ok ? [first.packet] : [];
  const second = approveWith([SIGNED, DELIVERY], packets);
  assert.ok(second.ok && second.created);
  if (!second.ok || !first.ok) return;
  assert.equal(second.packet.version, 2);
  assert.notEqual(second.packet.manifestHash, first.packet.manifestHash);
  assert.deepEqual(diffPackets(first.packet, second.packet), ['replaced i-receipt']);
});

test('manifest: an unchanged evidence set re-approves to the same packet', () => {
  const first = approveWith([RECEIPT, DELIVERY], []);
  assert.ok(first.ok);
  if (!first.ok) return;
  const again = approveWith([RECEIPT, DELIVERY], [first.packet]);
  assert.ok(again.ok);
  if (!again.ok) return;
  assert.equal(again.created, false);
  assert.equal(again.packet.packetId, first.packet.packetId);
});

test('manifest: the earlier packet version is never edited', () => {
  const first = approveWith([RECEIPT], []);
  assert.ok(first.ok);
  if (!first.ok) return;
  const snapshot = JSON.stringify(first.packet);
  const second = approveWith([SIGNED], [first.packet]);
  assert.ok(second.ok);
  assert.equal(JSON.stringify(first.packet), snapshot);
});

test('manifest: a packet approved under a different rule version is a different packet', () => {
  const other = computeDeadline({
    notification: notification({
      providerCaseId: 'dp-m1',
      deliveryId: 'dl-1',
      raisedAt: '2026-10-05T09:00:00Z',
      dueBySeconds: seconds('2026-10-26T03:59:59Z'),
    }),
    rules: ruleSetByVersion('disputes-2026.2'),
    zoneTableVersion: 'synthetic-2026e',
  });
  const a = manifestHash('c-1', entriesOf([RECEIPT]), DECISION.ruleVersion, DECISION.basis);
  const b = manifestHash('c-1', entriesOf([RECEIPT]), other.ruleVersion, other.basis);
  assert.notEqual(a, b);
});

test('manifest: two approvers of the identical evidence produce the identical manifest', () => {
  const first = approveWith([RECEIPT], [], 'approver-okafor');
  const second = approveWith([RECEIPT], [], 'approver-lindqvist');
  assert.ok(first.ok && second.ok);
  if (!first.ok || !second.ok) return;
  assert.equal(first.packet.manifestHash, second.packet.manifestHash);
  assert.notEqual(first.packet.approvedBy, second.packet.approvedBy);
});

test('manifest: approval requires an actor and a reason', () => {
  assert.equal(approveWith([RECEIPT], [], '   ').ok, false);
  assert.equal(approveWith([RECEIPT], [], 'approver-okafor', '  ').ok, false);
});

test('manifest: an empty evidence set cannot be approved', () => {
  assert.equal(approveWith([], []).ok, false);
});

test('manifest: a packet cannot consist only of model-suggested material', () => {
  const suggested = evidence({
    itemId: 'i-summary',
    caseId: 'c-1',
    kind: 'summary',
    body: 'drafted narrative',
    capturedAt: '2026-10-06T12:00:00Z',
    origin: 'MODEL_SUGGESTED',
  });
  const refused = approveWith([suggested], []);
  assert.equal(refused.ok, false);
  const accepted = approveWith([suggested, RECEIPT], []);
  assert.equal(accepted.ok, true);
});

test('manifest: a packet re-derives its own hash', () => {
  const first = approveWith([RECEIPT, DELIVERY], []);
  assert.ok(first.ok);
  if (!first.ok) return;
  assert.equal(reproduce(first.packet).ok, true);
});

test('manifest: a packet whose stored hash was altered fails reproduction', () => {
  const first = approveWith([RECEIPT, DELIVERY], []);
  assert.ok(first.ok);
  if (!first.ok) return;
  const tampered: Packet = { ...first.packet, manifestHash: first.packet.manifestHash.replace(/^./, '0') };
  assert.equal(reproduce(tampered).ok, false);
});

test('manifest: a packet whose entry digest was altered fails reproduction', () => {
  const first = approveWith([RECEIPT, DELIVERY], []);
  assert.ok(first.ok);
  if (!first.ok) return;
  const tampered: Packet = {
    ...first.packet,
    entries: first.packet.entries.map((e, i) => (i === 0 ? { ...e, contentHash: 'deadbeef' } : e)),
  };
  assert.equal(reproduce(tampered).ok, false);
});
