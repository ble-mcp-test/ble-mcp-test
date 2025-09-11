name: "Base PRP Template v2 - Context-Rich with Validation Loops (TypeScript/Node.js)"
description: |

## Purpose
Template optimized for AI agents to implement TypeScript/Node.js features with sufficient context and self-validation capabilities to achieve working code through iterative refinement.

## Core Principles
1. **Context is King**: Include ALL necessary documentation, examples, and caveats
2. **Validation Loops**: Provide executable tests/lints the AI can run and fix
3. **Information Dense**: Use keywords and patterns from the codebase
4. **Progressive Success**: Start simple, validate, then enhance
5. **Global rules**: Be sure to follow all rules in CLAUDE.md

---

## Goal
[What needs to be built - be specific about the end state and desires]

## Why
- [Business value and user impact]
- [Integration with existing features]
- [Problems this solves and for whom]

## What
[User-visible behavior and technical requirements]

### Validation Gates (MANDATORY SEQUENCE - NO EXCEPTIONS)

> **ENFORCEMENT**: Each gate MUST pass before proceeding to the next. No bypassing, no "tech debt" deferrals, no excuses.
> Gates must be completed sequentially - Gate N+1 cannot begin until Gate N passes completely.

**🚪 Gate 1: [Name] - [Objective]**
- **Validation Commands**: `command that must succeed`
- **Pass Criteria**: [Specific, measurable outcome]
- **Failure Action**: [What to do if gate fails]
- **Blocker**: Cannot proceed to Gate 2 until this passes

**🚪 Gate 2: [Name] - [Objective]**  
- **Validation Commands**: `command that must succeed`
- **Pass Criteria**: [Specific, measurable outcome]
- **Failure Action**: [What to do if gate fails]
- **Dependencies**: Gate 1 must pass first
- **Blocker**: Cannot proceed to Gate 3 until this passes

**🚪 Gate 3: [Name] - [Objective]**
- **Validation Commands**: `command that must succeed`
- **Pass Criteria**: [Specific, measurable outcome]  
- **Failure Action**: [What to do if gate fails]
- **Dependencies**: Gates 1 and 2 must pass first
- **Blocker**: Cannot claim completion until this passes

## All Needed Context

### Documentation & References (list all context needed to implement the feature)
```yaml
# MUST READ - Include these in your context window
- url: [Official API docs URL]
  why: [Specific sections/methods you'll need]
  
- file: [path/to/example.ts]
  why: [Pattern to follow, gotchas to avoid]
  
- doc: [Library documentation URL] 
  section: [Specific section about common pitfalls]
  critical: [Key insight that prevents common errors]

- docfile: [prp/ai_docs/file.md]
  why: [docs that the user has pasted in to the project]

```

### Current Codebase tree (run `tree` in the root of the project) to get an overview of the codebase
```bash

```

### Desired Codebase tree with files to be added and responsibility of file
```bash

```

### Known Gotchas of our codebase & Library Quirks
```typescript
// CRITICAL: [Library name] requires [specific setup]
// Example: Express middleware order matters - auth must come before routes
// Example: TypeScript strict mode requires explicit type annotations
// Example: We use pnpm - NEVER use npm or yarn commands
```

## Implementation Blueprint

### Data models and structure

Create the core data models, ensuring type safety and consistency.
```typescript
Examples: 
 - TypeScript interfaces
 - Type guards
 - Zod schemas for runtime validation
 - Class definitions with proper typing

```

### list of tasks to be completed to fulfill the PRP in the order they should be completed

```yaml
Task 1:
MODIFY src/existing_module.ts:
  - FIND pattern: "class OldImplementation"
  - INJECT after line containing "constructor"
  - PRESERVE existing method signatures

CREATE src/new_feature.ts:
  - MIRROR pattern from: src/similar_feature.ts
  - MODIFY class name and core logic
  - KEEP error handling pattern identical

...(...)

Task N:
...

```


### Per task pseudocode as needed added to each task
```typescript

// Task 1
// Pseudocode with CRITICAL details dont write entire code
async function newFeature(param: string): Promise<Result> {
    // PATTERN: Always validate input first (see src/validators.ts)
    const validated = validateInput(param);  // throws ValidationError
    
    // GOTCHA: This library requires connection pooling
    const conn = await getConnection();  // see src/db/pool.ts
    try {
        // PATTERN: Use existing retry utility
        const result = await retry(
            async () => {
                // CRITICAL: API returns 429 if >10 req/sec
                await rateLimiter.acquire();
                return await externalApi.call(validated);
            },
            { attempts: 3, backoff: 'exponential' }
        );
        
        // PATTERN: Standardized response format
        return formatResponse(result);  // see src/utils/responses.ts
    } finally {
        conn.release();
    }
}
```

### Integration Points
```yaml
DATABASE:
  - migration: "Add column 'feature_enabled' to users table"
  - index: "CREATE INDEX idx_feature_lookup ON users(feature_id)"
  
CONFIG:
  - add to: src/config/settings.ts
  - pattern: "export const FEATURE_TIMEOUT = Number(process.env.FEATURE_TIMEOUT || '30');"
  
ROUTES:
  - add to: src/routes/index.ts  
  - pattern: "router.use('/feature', featureRouter);"
```

## Gate Implementation Examples

### Standard TypeScript/Node.js Gate Patterns

**🚪 Syntax and Type Safety Gate Template:**
```bash
# MANDATORY - Must return exit code 0
pnpm run typecheck && pnpm run lint
```
**Pass Criteria**: Zero TypeScript errors, zero ESLint errors
**Common Failures**: Missing imports, type mismatches, unused variables
**Fix Strategy**: Address each error individually, never suppress warnings

**🚪 Unit Test Coverage Gate Template:**
```bash
# MANDATORY - All tests must pass
pnpm run test [specific-test-file]
```
**Pass Criteria**: 100% test pass rate + specific validations confirmed
**Test Pattern Example**:
```typescript
// CREATE feature.test.ts following this pattern:
import { describe, it, expect, vi } from 'vitest';

describe('newFeature', () => {
    it('should handle valid input', async () => {
        const result = await newFeature('valid_input');
        expect(result.status).toBe('success');
    });

    it('should reject invalid input', async () => {
        await expect(newFeature('')).rejects.toThrow('ValidationError');
    });

    it('should handle timeout gracefully', async () => {
        // Mock timeout scenario
        vi.mock('./external-api', () => ({
            call: vi.fn().mockRejectedValue(new Error('Timeout'))
        }));
        
        const result = await newFeature('valid');
        expect(result.status).toBe('error');
        expect(result.message).toContain('timeout');
    });
});
```

**🚪 Integration Test Gate Template:**
```bash
# MANDATORY - End-to-end functionality must work
pnpm run build && pnpm run start
# Test real functionality:
curl -X POST http://localhost:3000/feature \
  -H "Content-Type: application/json" \
  -d '{"param": "test_value"}'
```
**Pass Criteria**: Real requests succeed with expected responses
**Common Failures**: Port conflicts, missing environment variables, database connections
**Fix Strategy**: Debug step-by-step, check logs, verify all dependencies

## Gate Execution Rules

1. **Sequential Execution**: Gates must be completed in numerical order
2. **No Skipping**: Cannot proceed to Gate N+1 until Gate N passes completely  
3. **No Deferrals**: Cannot mark gates as "tech debt" or "will fix later"
4. **Evidence Required**: Each gate must produce verifiable pass/fail result
5. **Iterative Fixing**: If gate fails, fix issues and re-run until it passes
6. **No Bypass Mechanisms**: No "good enough" exceptions allowed

## Regression Protection Guidelines

### Gate Design Principles (Minimize Regression Risk)

**Order Gates by Stability (Most Stable First):**
1. **Syntax/Compilation**: Changes here rarely break other gates
2. **Unit Tests**: Isolated, less likely to cause regressions  
3. **Integration Tests**: Complex, changes here often break earlier gates
4. **End-to-End Tests**: Most complex, highest regression risk

**Stable Validation Commands:**
- Use commands that test isolated behavior: `pnpm run typecheck`
- Avoid commands dependent on external state: `curl localhost:3000` (port conflicts)
- Prefer deterministic outputs: specific error messages, exit codes
- Test single responsibility: one concept per gate

**Unstable Validation Commands (Avoid):**
- Commands requiring complex setup: database connections, external services
- Time-dependent tests: race conditions, timeouts
- Environment-dependent: hard-coded paths, system-specific behavior

### Change Impact Assessment Template

**Include this assessment for each gate:**
```markdown
**🚪 Gate N: [Name]**
- **Files Tested**: [List specific files this gate validates]
- **Regression Risk**: LOW/MEDIUM/HIGH 
- **Dependencies**: [Which earlier gates could be affected by changes to fix this gate]
- **Minimal Fix Strategy**: [How to fix failures with smallest possible change]
```

**Example:**
```markdown
**🚪 Gate 2: Unit Test Coverage**
- **Files Tested**: src/node/NodeBleClient.ts, src/node/types.ts
- **Regression Risk**: MEDIUM (constructor changes could affect syntax)
- **Dependencies**: Gate 1 (TypeScript compilation) could break if types change
- **Minimal Fix Strategy**: Add tests for missing scenarios, fix one failing test at a time
```

---

## Anti-Patterns to Avoid
- ❌ Don't create new patterns when existing ones work
- ❌ Don't skip validation because "it should work"  
- ❌ Don't ignore failing tests - fix them
- ❌ Don't mix callbacks and promises - use async/await
- ❌ Don't hardcode values that should be config
- ❌ Don't catch all exceptions - be specific
- ❌ Don't use npm/npx - always use pnpm

### Regression-Specific Anti-Patterns
- ❌ Don't skip regression runs after code changes - always re-run ALL gates
- ❌ Don't make large changes to fix single gate failures - use minimal fixes
- ❌ Don't continue past 3 regression cycles - escalate and reassess approach
- ❌ Don't "refactor while you're there" during gate execution - focus only on gate requirements
- ❌ Don't ignore git checkpoints - create commits after each gate passes