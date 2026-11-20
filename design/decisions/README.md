# Architecture decision records

Code defines behavior and regression tests protect it. An architecture
decision record (ADR) explains a choice the code cannot explain on its own.
If a design note already gives the reason, use it instead of writing an ADR.

Name the file after the choice. In a few paragraphs, record:

- **Context:** The problem and the constraint or evidence that mattered.
- **Decision:** What we chose and why the realistic alternative lost.
- **Consequences:** The cost, accepted risk, or evidence that would justify
  revisiting it. Link to the code and tests that enforce it.

Do not copy code, schemas, defaults, or test steps into the record.
