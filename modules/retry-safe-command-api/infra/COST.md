# Cost notes for the bounded cloud profile

**The article's results do not require this.** `make verify` runs the whole
conformance suite locally with no Google Cloud project. Deploy `infra/` only if
you want to watch the managed services behave.

## What bills continuously

| Resource | Billing behaviour | Notes |
|---|---|---|
| Spanner instance (100 processing units) | Charged from creation until deletion, whether or not you send traffic | This is the dominant cost of the lab. It is the smallest unit you can provision. |
| Spanner storage | Charged per GB-month | The lab writes a few hundred rows. Negligible. |
| Cloud Run | Charged per request and per allocated resource-time; scales to zero | `min_instance_count = 0`, so an idle lab costs nothing here. |
| Pub/Sub | Charged per volume of published and delivered data, with a monthly free allotment | Negligible at lab volume. Exactly-once subscriptions add publish-to-subscribe latency, not a separate line item. |
| Cloud Tasks | Charged per operation, with a monthly free allotment | Negligible at lab volume. |
| Cloud Logging | Charged per volume ingested beyond the free allotment | Keep the lab short-lived and avoid debug logging on the request path. |

Check current prices at https://cloud.google.com/pricing before you apply;
the rates change and this file is not a quote.

## Bounding the spend

1. Set `expiry_label` to a date you will honour.
2. Apply, run the experiment, and destroy the same day. Spanner is the reason.
3. Never leave the instance running overnight "to finish tomorrow".

```bash
terraform apply -var project_id=YOUR_PROJECT -var image=YOUR_IMAGE -var expiry_label=YYYY-MM-DD
# ... run the experiment ...
terraform destroy -var project_id=YOUR_PROJECT -var image=YOUR_IMAGE -var expiry_label=YYYY-MM-DD
```

## Verifying cleanup

```bash
gcloud spanner instances list
gcloud run services list
gcloud pubsub topics list
gcloud tasks queues list --location=us-central1
```

All four should be empty of `retry-safe-*` resources when you are done.
