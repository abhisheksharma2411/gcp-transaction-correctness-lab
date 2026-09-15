# ADR-001: Traffic routing and write authority are separate mechanisms

- Status: Accepted
- Date: 2026-09-15
- Article: 03

## Context

"Active-active" is usually implemented as a global load balancer sending
traffic to compute in two regions. The tempting conclusion is that the system
therefore has two active sides.

## Decision

Model traffic movement and authority movement as two independent mechanisms on
two independent clocks, and make the application's behaviour during the gap
between them the subject of the lab.

## Why this option

They genuinely are independent, and the documented numbers make the gap
concrete rather than rhetorical.

Traffic moves on health checks. The load-balancing defaults are a 5-second
check interval with a 2-probe unhealthy threshold, so a backend can be drained
in roughly ten seconds.

Authority moves on leader election. Spanner's region-types page states that
"in the unlikely event of the loss of all replicas in the default leader
region, new leader replicas are chosen from the second read-write region," and
a Spanner engineering manager documented the window as "less than 10 seconds".

Those two numbers are similar, which is worse than if they were different,
because it invites the assumption that they are the same event. They are not
coordinated, they are not causally linked, and neither is coordinated with the
application's cache expiry.

Leader-aware routing settles the remaining question. It is "enabled by default"
and routes session creation to the leader region "even if the write doesn't
originate from the leader region." So writing from the second region does not
make that region an authority; it makes it a client of the authority.

## Consequences

"Active-active" has to be stated per operation rather than per system. Serving
is active-active. Reads may be. Write authority is not, and cannot be made so
by moving traffic.

The lab therefore models region identity, a traffic-move delay, and an election
delay as three separate parameters, and the article's decision diagram is drawn
around the window where they disagree.

## Conditions that would change the decision

Nothing available today. A design with genuinely independent regional write
authority would need conflict resolution, which reintroduces exactly the
reconciliation problem this article exists to avoid.
