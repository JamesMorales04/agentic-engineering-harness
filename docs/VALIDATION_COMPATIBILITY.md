# Validation compatibility matrix

This is a support matrix for project-native adapters, not the AEH reference
architecture. AEH consumes capability contracts and normalized evidence.

| Ecosystem | TestExecutionProvider | BddExecutionProvider | IntegrationEnvironmentProvider |
| --- | --- | --- | --- |
| Node.js | Vitest, Jest, `node:test` | Cucumber-JS | Testcontainers Node, Docker/Podman/OCI, project command |
| Python | pytest, `unittest` | pytest-bdd, Behave | Testcontainers Python, Docker/Podman/OCI, project command |
| JVM | JUnit, Maven, Gradle | Cucumber-JVM | Testcontainers Java, Docker/Podman/OCI, project command |
| .NET | xUnit, NUnit, `dotnet test` | Reqnroll | Testcontainers .NET, Docker/Podman/OCI, project command |
| Go | `go test` | project-compatible provider | Testcontainers Go, Docker/Podman/OCI, project command |
| Rust | `cargo test` | project-compatible provider | Testcontainers Rust, Docker/Podman/OCI, project command |
| Ruby | RSpec | Cucumber-Ruby | Testcontainers Ruby, Docker/Podman/OCI, project command |

Reqnroll is an optional .NET BDD provider. xUnit and `dotnet test` are optional
.NET test providers. Testcontainers is a recommended project-native
implementation where its ecosystem supports it; AEH does not require any of
these technologies.
