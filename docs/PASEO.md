# Paseo Integration

Paseo is the default orchestration control plane because an existing lead agent can spawn an OpenCode subagent in the same workspace and keep controlling it remotely.

The executor uses the scriptable flow `paseo run --background --quiet`, `paseo wait`, `paseo logs`, and `paseo send` for repairs. When the lead itself is a Paseo agent, Paseo supplies parent/workspace defaults automatically.

The lead remains responsible for architecture and final semantic review. Paseo is an execution/control primitive, not the source of engineering truth.

For a directly container-isolated worker, configure `orchestration.provider: podman`. This trades Paseo child-session visibility for stronger process isolation. Advanced setups can instead configure a Paseo custom provider binary/wrapper around a containerized OpenCode CLI.
