# Project retirement

Use a fresh instance name. Seed three old projects, review the dry run, and
apply it to the throwaway database before the app starts:

```sh
name=project-retirement-proof
home="/tmp/goblin-verify/$name"
db="$home/state/goblin.sqlite"
id=$(GOBLIN_HOME="$home" bun --no-env-file .agents/skills/verify-goblin/scripts/seed-retired-projects.ts)
bun scripts/retire-projects.ts --database "$db" --to-bot "$id" --dry-run | tee "$home/preview.json"
bun scripts/retire-projects.ts --database "$db" --to-bot "$id" --apply "$(jq -r .approval "$home/preview.json")"
bun run try "$name"
```

1. At desktop and phone widths, look for Projects and New project in the
   chat list and You menu. Neither appears. The old `/app/projects` and
   `/app/p/<project-id>` routes return 404.
2. Open **Workshop**. Its main chat starts empty. Expand **Side chats for
   Workshop**, open **Saw repairs**, and check its old message, its pinned
   **Saw inventory** note and that memory is excluded.
3. Expand Little Goblin's side chats. **Seeds to order** opens its old
   conversation; **Garden instructions** is in Little Goblin's notes.
4. Open **Archive**. **Spare keys** is here, not in the ordinary chat list.
5. Send a harmless message in Workshop's main chat. In the isolated
   database, inspect its prompt snapshot for the original instructions and
   Workshop folder.
6. Close the browser and run `bun run try down "$name"`.
