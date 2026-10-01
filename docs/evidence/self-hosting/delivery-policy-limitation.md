# Self-hosting GitHub delivery policy limitation

This limitation was documented before changing the delivery policy model.

The project configuration currently exposes `delivery.github.enabled` as a broad switch. When enabled, `configuredExternalEffects` adds `github.issue.create`, `github.branch.create`, `git.push`, and, unless explicitly disabled, `github.pull-request.create`. A project that only wants to publish a branch and pull request cannot express that narrower scope.

The accepted-delivery implementation also enters through `finalizeAcceptedIssue`. A CHANGE TaskContract without `contract.issue` returns `SKIPPED`, even if GitHub delivery is enabled and the operation reached an accepted candidate. Thus the current path cannot deliver the original self-hosting Home request, which is not issue-derived.

The model now requires an explicit closed action list whenever GitHub delivery is enabled. The AEH self-hosting checkout allows only local delivery branch creation and commit, `git.push`, and pull-request create/update. Issue creation, merge, force push, branch deletion, repository deletion, and credential mutation remain outside the configured/supported action set. External actions remain subject to the current candidate, accepted AcceptanceOracle, project policy, ToolActionGate, and exact human action authorization where required.

The operation finalizer now has a no-Issue CHANGE path. It creates the configured local delivery branch only after acceptance, commits through `git.commit`, pushes without force, and creates or updates the matching PR through the existing action gate. Issue-derived handoff behavior remains governed by its sealed TaskContract and separately configured actions.
