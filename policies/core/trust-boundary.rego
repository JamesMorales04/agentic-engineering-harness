package harness.trust_boundary

# Input shape expected from the harness policy adapter:
# {
#   "changedFiles": [...],
#   "frozenPatterns": [...],
#   "workerRole": "implementation-worker"
# }
#
# Pattern expansion is intentionally performed by the harness before OPA.

default allow := true

deny contains "implementation worker changed a frozen artifact" if {
  input.workerRole == "implementation-worker"
  count(input.frozenChangedFiles) > 0
}
