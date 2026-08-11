package harness.schema

default allow_schema_changes := false

allow_schema_changes if {
  input.taskContract.constraints.schemaChanges == true
}

deny contains "schema change is not authorized by the TaskContract" if {
  input.schemaChanged == true
  not allow_schema_changes
}
