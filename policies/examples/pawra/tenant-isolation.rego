package pawra.tenant_isolation

# This is a policy scaffold, not a replacement for executable tenant-isolation tests.
# Consumer repositories should populate evidence from their own architecture/security validators.

deny contains "tenant isolation evidence failed" if {
  input.validation.tenantIsolation == "FAIL"
}
