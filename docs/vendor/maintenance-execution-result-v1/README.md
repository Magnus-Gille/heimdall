# Brokkr maintenance-execution-result v1 vendor provenance

Vendored from Brokkr PR #79, merged commit `4075642c6dd23bec47faf331e219fe0df82981d7`:

- `docs/maintenance-execution-result-v1.schema.json`
- `tests/fixtures/maintenance-execution-result/`

The schema copy is byte-identical (SHA-256
`7dc0510e413ae6634b1eaa9738f30668727b9e5d4bc210b89c857934ba06b312`).
Fixtures are intentionally consumed from `test/fixtures/` so all canonical
positive states and the producer adversarial corpus are regression-tested.

This is an observer contract only; it grants Heimdall no maintenance, promotion,
service-liveness, alerting, or actuation authority.
