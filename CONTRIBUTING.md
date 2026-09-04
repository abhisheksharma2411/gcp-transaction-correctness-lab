# Contributing

Corrections are genuinely welcome, particularly to claims about Google Cloud
behaviour. Product semantics change, and a lab that quietly goes stale is worse
than no lab.

## Before opening a pull request

```bash
cd modules/<module>
make verify
```

That must pass. If it does not pass on a clean checkout, that is itself a bug
worth reporting.

## What makes a good contribution

- **A correction with a source.** If a documented guarantee has changed, link
  the current page. Claims in this repository are traceable to a source matrix
  in the corresponding article, and corrections should update both.
- **A new negative control.** A test proving the harness catches a bug it
  currently misses is the most valuable contribution here.
- **A reproduction.** If a module's documented result does not reproduce on
  your machine, open an issue with your Node version and the output. That is
  useful information, not a nuisance.

## What to avoid

- Real data of any kind. Synthetic only.
- Adding runtime dependencies to a module that has none.
- Broadening an IAM binding for convenience.
- Claims that a design guarantees an outcome it can only make detectable.

## Style

Match the surrounding code. Comments should explain why a decision was made,
not restate what the line does. Where a design choice is non-obvious, prefer an
ADR in the module's `docs/adr/` over a long comment.
