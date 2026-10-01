package harness.dependencies

default allow_new_dependencies := false

allow_new_dependencies if {
  input.taskContract.constraints.newDependencies == true
}

deny contains "new dependency is not authorized by the TaskContract" if {
  count(input.newDependencies) > 0
  not allow_new_dependencies
}
