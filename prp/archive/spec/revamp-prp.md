## FEATURE:
Update the PRP process to be wholly contained within one PRP directory
- Rename `./PRPs` to `./prp` because I'm tired of always holding down the shift button. Accommodate the lazy human in the loop. Spare them from (more) carpal tunnel
- move spec docs location from `./docs` to `./prp/spec`
- move PRP output location from `./PRPs` to `./prp/prompt`
- move examples from `./examples` to `./prp/example`
- add a `./prp/complete` or `./prp/archive` directory with the same spec, prompt, example structure to hold completed work so that we don't get confused between active projects and historical curiosities
- update the `.claude/commands/generate-prp.md` slash command to use our new directory locations
- update the `.claude/commands/execute-prp.md` slash commands to use our new directory locations
- Add a `./prp/README.md` that explains our PRP process and sequences. Most likely we will want to feed that into every spec document as documentation
- Add an empty spec doc template to `./prp/spec`

## EXAMPLES:

## DOCUMENTATION:
- https://github.com/coleam00/context-engineering-intro/blob/main/README.md
- https://www.philschmid.de/context-engineering
- https://github.com/Wirasm/PRPs-agentic-eng

## OTHER CONSIDERATIONS:
- after this change made only docs/API.md and docs/MIGRATION.md should be in the `./docs` directory