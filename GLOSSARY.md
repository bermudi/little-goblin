# Glossary

- **Responsibility:** what Goblin owes the operator, as a durable record. It is separate from who does the work.
- **Delegation:** one external coding agent that Goblin starts with the `delegate` tool. It runs in a Herdr terminal.
- **Harness:** a coding agent program that a delegation runs, such as codex or pi.
- **Herdr:** the terminal multiplexer where harnesses run.
- **Desk:** the operator's own Herdr session, `default`. The `herdr` tool reaches it.
- **Subagent:** a durable run on Goblin's own Pi Durable runtime. It has two kinds, worker and computer.
- **Worker:** a subagent that does standalone work in a conversation's sandbox.
- **Computer:** a subagent that does screen work on a named desktop.
- **Settlement:** the point where a delegation or subagent run stops and states a result: done, needs input, or failed.
- **Worker report:** one settlement filed on a responsibility. It is the agent's claim, and Goblin still checks it.
- **Notice:** the machine message that gives a settlement to Goblin and wakes the conversation.
