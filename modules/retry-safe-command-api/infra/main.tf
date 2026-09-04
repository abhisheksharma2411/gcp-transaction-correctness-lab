# Bounded cloud profile for the retry-safe command API.
#
# This is opt-in. `make verify` never touches it. Nothing here is required to
# reproduce the article's results; the local suite proves the same invariants
# with no project and no billing. Deploy this only if you want to observe the
# managed services themselves.
#
# Cost warning: a Spanner instance bills continuously from creation. The
# smallest unit is 100 processing units. Read infra/COST.md before applying,
# and run `terraform destroy` when finished.

terraform {
  required_version = ">= 1.5.0"
  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 6.0"
    }
  }
}

provider "google" {
  project = var.project_id
  region  = var.region
}

variable "project_id" {
  type        = string
  description = "Google Cloud project that will be billed for this lab."
}

variable "region" {
  type        = string
  default     = "us-central1"
  description = "Single region. The lab does not need multi-region and multi-region Spanner costs materially more."
}

variable "image" {
  type        = string
  description = "Container image for the command API, e.g. REGION-docker.pkg.dev/PROJECT/REPO/retry-safe-command-api:TAG."
}

variable "expiry_label" {
  type        = string
  description = "Date after which this lab should be destroyed, as YYYY-MM-DD. Used only as a label for cleanup sweeps."
}

locals {
  labels = {
    lab        = "retry-safe-command-api"
    article    = "01"
    managed-by = "terraform"
    expires-on = replace(var.expiry_label, "/[^0-9-]/", "")
  }
}

# --- Identity -----------------------------------------------------------

resource "google_service_account" "api" {
  account_id   = "retry-safe-api"
  display_name = "Retry-safe command API"
  description  = "Runtime identity for the Cloud Run command API. Never used by humans."
}

resource "google_service_account" "reconciler" {
  account_id   = "retry-safe-reconciler"
  display_name = "Retry-safe reconciliation worker"
  description  = "Separate identity so the reconciliation path can be authorised independently of the request path."
}

# The API writes operations and outbox rows. It does not administer the database.
resource "google_spanner_database_iam_member" "api_rw" {
  instance = google_spanner_instance.lab.name
  database = google_spanner_database.payments.name
  role     = "roles/spanner.databaseUser"
  member   = "serviceAccount:${google_service_account.api.email}"
}

resource "google_spanner_database_iam_member" "reconciler_rw" {
  instance = google_spanner_instance.lab.name
  database = google_spanner_database.payments.name
  role     = "roles/spanner.databaseUser"
  member   = "serviceAccount:${google_service_account.reconciler.email}"
}

resource "google_pubsub_topic_iam_member" "api_publish" {
  topic  = google_pubsub_topic.payment_events.name
  role   = "roles/pubsub.publisher"
  member = "serviceAccount:${google_service_account.api.email}"
}

resource "google_project_iam_member" "api_enqueue" {
  project = var.project_id
  role    = "roles/cloudtasks.enqueuer"
  member  = "serviceAccount:${google_service_account.api.email}"
}

# --- State --------------------------------------------------------------

resource "google_spanner_instance" "lab" {
  name             = "retry-safe-lab"
  config           = "regional-${var.region}"
  display_name     = "Retry-safe lab"
  processing_units = 100
  labels           = local.labels
}

# The database is created empty and the schema is applied separately with
# `gcloud spanner databases ddl update --ddl-file=infra/schema.sql`. Splitting
# schema.sql into Terraform DDL statements inside HCL is easy to get subtly
# wrong, and a half-applied payment schema is a bad way to learn that.
resource "google_spanner_database" "payments" {
  instance = google_spanner_instance.lab.name
  name     = "payments"

  # Set to false only because this is a disposable lab.
  deletion_protection = false
}

# --- Delivery -----------------------------------------------------------

resource "google_pubsub_topic" "payment_events" {
  name   = "payment-events"
  labels = local.labels
}

resource "google_pubsub_subscription" "ledger" {
  name  = "payment-events-ledger"
  topic = google_pubsub_topic.payment_events.id

  # Exactly-once delivery removes redelivery after a successful acknowledgment
  # within one region for pull subscriptions. It does not remove publish-side
  # duplicates, and it does not make the consumer's side effect idempotent.
  # The consumer still deduplicates on effect identity.
  enable_exactly_once_delivery = true
  ack_deadline_seconds         = 60

  retry_policy {
    minimum_backoff = "10s"
    maximum_backoff = "600s"
  }

  dead_letter_policy {
    dead_letter_topic     = google_pubsub_topic.dead_letter.id
    max_delivery_attempts = 10
  }

  labels = local.labels
}

resource "google_pubsub_topic" "dead_letter" {
  name   = "payment-events-dead-letter"
  labels = local.labels
}

# Reconciliation of unknown outcomes. Task names are derived from the operation
# id, so enqueueing the same reconciliation twice enqueues it once.
resource "google_cloud_tasks_queue" "reconcile" {
  name     = "payment-reconcile"
  location = var.region

  rate_limits {
    max_dispatches_per_second = 10
    max_concurrent_dispatches = 5
  }

  retry_config {
    max_attempts       = 10
    min_backoff        = "10s"
    max_backoff        = "3600s"
    max_doublings      = 5
    max_retry_duration = "86400s"
  }
}

# --- Compute ------------------------------------------------------------

resource "google_cloud_run_v2_service" "api" {
  name     = "retry-safe-command-api"
  location = var.region
  labels   = local.labels

  deletion_protection = false
  # The lab does not create a load balancer, so keep the service off the public
  # internet entirely. A production deployment would front this with a global
  # external Application Load Balancer and Cloud Armor; neither is needed to
  # demonstrate the invariant, and both add cost.
  ingress = "INGRESS_TRAFFIC_INTERNAL_ONLY"

  template {
    service_account = google_service_account.api.email

    # The request path is short. A long timeout here would only hold a caller
    # open while the outcome is already durably recorded as unknown.
    timeout = "15s"

    max_instance_request_concurrency = 40

    scaling {
      min_instance_count = 0
      max_instance_count = 4
    }

    containers {
      image = var.image

      resources {
        limits = {
          cpu    = "1"
          memory = "512Mi"
        }
      }

      env {
        name  = "SPANNER_INSTANCE"
        value = google_spanner_instance.lab.name
      }
      env {
        name  = "SPANNER_DATABASE"
        value = google_spanner_database.payments.name
      }
      env {
        name  = "PAYMENT_EVENTS_TOPIC"
        value = google_pubsub_topic.payment_events.name
      }
      env {
        name  = "RECONCILE_QUEUE"
        value = google_cloud_tasks_queue.reconcile.name
      }
    }
  }
}

output "service_uri" {
  value       = google_cloud_run_v2_service.api.uri
  description = "Internal URI of the command API."
}

output "destroy_reminder" {
  value       = "Spanner bills continuously. Run 'terraform destroy' when the experiment is finished."
  description = "Cleanup reminder."
}
