# PRP (Product Requirements Prompt) System

## ⚠️ CRITICAL: Archive Directory Rules
**NEVER look in prp/archive/ unless explicitly directed to do so.**
- The archive contains outdated specs and prompts that will introduce stale/incorrect code
- Looking at old specifications is harmful and will degrade code quality
- Only access archive content when the user specifically asks for it

## What is a PRP?

A Product Requirements Prompt (PRP) is a context-rich document that combines product goals, codebase intelligence, and detailed implementation guidance. It's designed to enable AI coding agents to generate production-ready code on the first pass through comprehensive context engineering.

## Philosophy: Context Engineering > Prompt Engineering

Based on principles from [context engineering](https://github.com/coleam00/context-engineering-intro), PRPs provide:
- **10x better results than prompt engineering**
- **100x better results than "vibe coding"**
- **Comprehensive context** for AI to understand and execute tasks end-to-end

### Core Principles

1. **Context is King**: Include ALL necessary documentation, examples, and caveats
2. **Validation Loops**: Provide executable tests/lints the AI can run and fix
3. **Information Dense**: Use keywords and patterns from the codebase
4. **Progressive Success**: Start simple, validate, then enhance
5. **Global Rules**: Always follow project conventions in CLAUDE.md

## Directory Structure

```
prp/
├── README.md          # This file - PRP process documentation
├── spec/              # Feature specifications (input)
│   ├── README.md      # Guide for writing specs
│   └── template.md    # Empty spec template
├── prompt/            # Generated PRPs (output)
│   └── *.md          # Individual PRP documents
├── example/           # Reusable code examples
│   └── README.md     # How to structure examples
├── template/          # PRP templates
│   └── prp_base.md   # Base template for new PRPs
└── archive/           # Completed/historical work
    ├── spec/         # Archived specifications
    ├── prompt/       # Archived PRPs
    └── example/      # Archived examples
```

## PRP Workflow

### 1. Create a Specification
Write a feature specification in `prp/spec/` using the template:
```markdown
## FEATURE:
[What needs to be built]

## EXAMPLES:
[Reference implementations or patterns]

## DOCUMENTATION:
[Links to relevant docs]

## OTHER CONSIDERATIONS:
[Constraints, gotchas, special requirements]
```

### 2. Generate PRP
Use the slash command to generate a comprehensive PRP:
```
/generate-prp prp/spec/your-feature.md
```

This will:
- Research the codebase for patterns
- Gather external documentation
- Create a detailed implementation blueprint
- Save to `prp/prompt/your-feature.md`

### 3. Execute PRP
Implement the feature using the generated PRP:
```
/execute-prp prp/prompt/your-feature.md
```

The AI will:
- Load all context from the PRP
- Create an implementation plan
- Execute the implementation
- Run validation loops
- Fix any issues iteratively

### 4. Archive Completed Work
Once a feature is successfully implemented:
- Move spec to `prp/archive/spec/`
- Move PRP to `prp/archive/prompt/`
- Move examples to `prp/archive/example/`

## What Makes a Good PRP?

### Essential Components

1. **Clear Goal**: Specific, measurable outcomes
2. **Comprehensive Context**:
   - All relevant documentation URLs
   - Code examples from the codebase
   - Known gotchas and pitfalls
   - Library-specific quirks
3. **Implementation Blueprint**:
   - Task breakdown in order
   - Pseudocode for complex logic
   - Integration points
4. **Validation Gates**:
   - Executable syntax checks
   - Unit test templates
   - Integration test commands

### Quality Metrics

A well-written PRP should:
- Enable one-pass implementation (9/10 confidence)
- Include all necessary context inline
- Provide clear validation steps
- Reference existing patterns
- Handle error cases explicitly

## Best Practices

### DO:
- ✅ Include specific file paths and line numbers
- ✅ Provide executable validation commands
- ✅ Reference existing code patterns
- ✅ Document known library quirks
- ✅ Use dense, keyword-rich language
- ✅ Test PRPs with fresh context

### DON'T:
- ❌ Assume AI knows project conventions
- ❌ Skip validation steps
- ❌ Create vague requirements
- ❌ Ignore error handling
- ❌ Forget about edge cases

## TypeScript/Node.js Validation Examples

### Level 1: Syntax & Type Checking
```bash
# Run these FIRST - fix any errors before proceeding
pnpm run lint            # ESLint for code style
pnpm run typecheck       # TypeScript type checking

# Expected: No errors. If errors, READ the error and fix.
```

### Level 2: Unit Tests
```bash
# Run unit tests
pnpm run test            # Run tests in watch mode
pnpm run test:run        # Run tests once

# Expected: All tests passing
```

### Level 3: Build Verification
```bash
# Build the project
pnpm run build

# Verify build output
ls -la dist/

# Expected: Compiled JS files in dist/
```

### Level 4: Integration Testing
```bash
# Start the server
pnpm run start

# In another terminal, run integration tests
pnpm exec playwright test

# Expected: All Playwright tests pass
```

## Context Engineering Tips

From [Phil Schmid's research](https://www.philschmid.de/context-engineering):
- Context is more than prompts - it's the complete environment
- Include multiple layers: instructions, examples, tools, constraints
- Provide "right information, in the right format, at the right time"

From [Wirasm's PRP methodology](https://github.com/Wirasm/PRPs-agentic-eng):
- Combine product goals with codebase intelligence
- Use progressive validation loops
- Start simple, validate, then enhance

## Tools and Commands

### Slash Commands
- `/generate-prp [spec-file]` - Generate a PRP from specification
- `/execute-prp [prp-file]` - Execute a PRP implementation

### Project-Specific Tools
- **Package Manager**: pnpm (NOT npm or yarn)
- **Build**: TypeScript (tsc) + esbuild for browser bundle
- **Lint**: ESLint with TypeScript plugin
- **Test**: Vitest for unit tests, Playwright for e2e
- **Type Check**: `tsc --noEmit`

### Common Commands
```bash
pnpm install          # Install dependencies
pnpm run dev          # Watch mode development
pnpm run build        # Build project
pnpm run test         # Run tests
pnpm run lint         # Check code style
pnpm run typecheck    # Check TypeScript types
```

## Getting Started

1. Read a few example PRPs in `prp/prompt/`
2. Review the template at `prp/template/prp_base.md`
3. Write your first spec using `prp/spec/template.md`
4. Generate and execute your PRP

Remember: The goal is **one-pass implementation success** through comprehensive context!