package harness.trust_boundary

# Input shape expected from the harness policy adapter:
# {
#   "changedFiles": [...],
#   "frozenChangedFiles": [...],
#   "identity": {"logicalAgent": "...", "role": "...", "permissions": {...}}
# }
#
# Pattern expansion is intentionally performed by the harness before OPA.

default allow := true

deny contains "implementation agent changed a frozen artifact" if {
  input.identity.role == "implementer"
  count(input.frozenChangedFiles) > 0
}

deny contains "read-only role has write permission" if {
  input.identity.role == "reviewer"
  input.identity.permissions.write == "allow"
}

deny contains "network permission is forbidden for high-risk execution" if {
  input.identity.risk == "high"
  input.identity.permissions.network == "allow"
}
