# Status

## Sub-features

Service version, start time and uptime, memory state.

## How to get to it (user POV)

Sidebar → Status.

## Driving it with agent-browser

```sh
ab click 'button[aria-label="Status"]'
ab snapshot
```

Proof: version matches `package.json`, and `started` is this instance's boot time.

## Gotchas

Memory is off on a throwaway instance, so this can't prove anything about the memory stack.
