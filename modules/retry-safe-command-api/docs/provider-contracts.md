# Provider idempotency contracts are not one contract

The simulator in `src/provider.ts` models a provider that honours an
idempotency key by returning the first outcome instead of applying a second
effect. That is a *modelled* contract. Real providers differ in ways that
change the correct client design, so the model is a starting assumption to
verify against your provider's documentation, not a property you can assume.

Three published contracts, each verified on 2026-09-03:

## Stripe

[Idempotent requests](https://docs.stripe.com/api/idempotent_requests)

- Stores the status code and body of the first request for a given key,
  "regardless of whether it succeeds or fails", and returns the same result on
  subsequent requests with that key, "including 500 errors".
- Compares incoming parameters against the original request and errors when
  they differ.
- Keys may be removed "after they're at least 24 hours old", and Stripe states
  that it generates a new request if a key is reused after the original is
  pruned. **This is the failure mode that `T8` in the conformance suite
  exists for.**
- Results are saved only after endpoint execution begins, so a request that
  fails validation or conflicts with a concurrent request does not create a
  stored idempotent result.

## PayPal

[Idempotency](https://developer.paypal.com/api/rest/reference/idempotency/)

- Uses the `PayPal-Request-Id` header. Notably: "Not all APIs support this
  header", and how long the ID is stored is per-API.
- Returns "the latest status of the previous request that used that same
  header" rather than a stored copy of the first response.
- Omitting the header duplicates the request.
- Two simultaneous requests with the same header: PayPal "processes the first
  request and might fail the second request".

## Amazon Web Services

[Making retries safe with idempotent APIs](https://aws.amazon.com/builders-library/making-retries-safe-with-idempotent-APIs/)

- Models the client request identifier as `ClientToken`, and returns a
  *semantically equivalent* response to a retry rather than a byte-identical
  replay.
- Stores the original request parameters alongside the token, and returns a
  validation error on a parameter mismatch, on the reasoning that a different
  parameter combination probably means different intent.
- Discusses late-arriving retries explicitly, including the case where the
  resource has since been deleted.

## What differs, and why it matters

| Question | Stripe | PayPal | AWS |
|---|---|---|---|
| Replays the first response? | Yes, stored response | Returns latest status | Semantically equivalent response |
| Parameter mismatch on reuse | Error | Not specified in the general guide | Validation error |
| Concurrent duplicate | Not saved; conflicts error | First processed, second may fail | Not specified in the article |
| Key lifetime | At least 24 hours, then pruned | Per-API | Discussed as a design question |
| Coverage | API-wide for mutating endpoints | Not all APIs | Per-operation |

Two consequences for the design in this module:

1. **The caller cannot outsource correctness to the provider.** A provider
   that returns "latest status" instead of a stored response, or that fails a
   concurrent duplicate, requires the caller to hold its own durable operation
   record. That is why `payment_operations` exists and why the service never
   depends on the provider recognising the key.
2. **Key lifetime is a shared risk.** Every contract above prunes keys
   eventually. The `effect_claims` table outlives the operation record for
   exactly this reason: after the provider and the service have both forgotten
   the key, the question "did this order already move money?" still needs an
   answer.
