# Create PRP

## Feature file: $ARGUMENTS

Generate a complete PRP for general feature implementation with thorough research. Ensure context is passed to the AI agent to enable self-validation and iterative refinement. 

First, read these files to understand the PRP process:
1. Read `prp/README.md` to understand the PRP philosophy and workflow
2. Read `prp/spec/README.md` to understand how to interpret specifications
3. Then read the feature file to understand what needs to be created, how the examples provided help, and any other considerations.

The AI agent only gets the context you are appending to the PRP and training data. Assuma the AI agent has access to the codebase and the same knowledge cutoff as you, so its important that your research findings are included or referenced in the PRP. The Agent has Websearch capabilities, so pass urls to documentation and examples.

## Research Process

1. **Codebase Analysis**
   - Search for similar features/patterns in the codebase
   - Identify files to reference in PRP
   - Note existing conventions to follow
   - Check test patterns for validation approach

2. **External Research**
   - Search for similar features/patterns online
   - Library documentation (include specific URLs)
   - Implementation examples (GitHub/StackOverflow/blogs)
   - Best practices and common pitfalls

3. **User Clarification** (if needed)
   - Specific patterns to mirror and where to find them?
   - Integration requirements and where to find them?

## PRP Generation

Using prp/template/prp_base.md as template:

### Critical Context to Include and pass to the AI agent as part of the PRP
- **Documentation**: URLs with specific sections
- **Code Examples**: Real snippets from codebase
- **Gotchas**: Library quirks, version issues
- **Patterns**: Existing approaches to follow

### Implementation Blueprint
- Start with pseudocode showing approach
- Reference real files for patterns
- Include error handling strategy
- list tasks to be completed to fullfill the PRP in the order they should be completed

### Validation Gates (Must be Executable) eg for TypeScript/Node.js
```bash
# Syntax/Style
pnpm run lint && pnpm run typecheck

# Unit Tests
pnpm run test

```

*** CRITICAL AFTER YOU ARE DONE RESEARCHING AND EXPLORING THE CODEBASE BEFORE YOU START WRITING THE PRP ***

*** ULTRATHINK ABOUT THE PRP AND PLAN YOUR APPROACH THEN START WRITING THE PRP ***

## Output
Save as: `prp/prompt/{feature-name}.md`

## Quality Checklist
- [ ] All necessary context included
- [ ] Validation gates are executable by AI
- [ ] References existing patterns
- [ ] Clear implementation path
- [ ] Error handling documented

Score the PRP on a scale of 1-10 (confidence level to succeed in one-pass implementation using claude codes)

## Git Workflow (Final Step)
After successfully generating the PRP:
1. Check current git branch
2. Branch handling:
   - If on main/master branch:
     - Extract feature name from spec filename (e.g., `prp/spec/add-auth.md` → `feature/add-auth`)
     - Create and checkout feature branch: `git checkout -b feature/{name}`
   - If on an unrelated feature branch:
     - Ask the user: "You're currently on branch '{current-branch}'. Should I:
       a) Create a new branch for this PRP
       b) Commit to the current branch
       c) Skip the git commit"
3. Stage and commit both spec and PRP files (unless user chose to skip):
   ```bash
   git add prp/spec/{feature}.md prp/prompt/{feature}.md
   git commit -m "docs: add spec and PRP for {feature}"
   ```
4. This preserves planning artifacts and creates a clear implementation trail in git history

Remember: The goal is one-pass implementation success through comprehensive context.