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

### Success Criteria
- [ ] [Specific measurable outcomes]

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

## Validation Loop

### Level 1: Syntax & Style
```bash
# Run these FIRST - fix any errors before proceeding
pnpm run lint              # ESLint with auto-fix
pnpm run typecheck         # TypeScript type checking

# Expected: No errors. If errors, READ the error and fix.
```

### Level 2: Unit Tests each new feature/file/function use existing test patterns
```typescript
// CREATE new_feature.test.ts with these test cases:
import { describe, it, expect, vi } from 'vitest';

describe('newFeature', () => {
    it('should handle happy path', async () => {
        const result = await newFeature('valid_input');
        expect(result.status).toBe('success');
    });

    it('should throw ValidationError for invalid input', async () => {
        await expect(newFeature('')).rejects.toThrow(ValidationError);
    });

    it('should handle external API timeout gracefully', async () => {
        vi.mock('./external-api', () => ({
            call: vi.fn().mockRejectedValue(new Error('Timeout'))
        }));
        
        const result = await newFeature('valid');
        expect(result.status).toBe('error');
        expect(result.message).toContain('timeout');
    });
});
```

```bash
# Run and iterate until passing:
pnpm run test new_feature.test.ts
# If failing: Read error, understand root cause, fix code, re-run (never mock to pass)
```

### Level 3: Integration Test
```bash
# Build and start the service
pnpm run build
pnpm run start

# Test the endpoint
curl -X POST http://localhost:3000/feature \
  -H "Content-Type: application/json" \
  -d '{"param": "test_value"}'

# Expected: {"status": "success", "data": {...}}
# If error: Check console output for stack trace
```

## Final validation Checklist
- [ ] All tests pass: `pnpm run test`
- [ ] No linting errors: `pnpm run lint`
- [ ] No type errors: `pnpm run typecheck`
- [ ] Build succeeds: `pnpm run build`
- [ ] Manual test successful: [specific curl/command]
- [ ] Error cases handled gracefully
- [ ] Logs are informative but not verbose
- [ ] Documentation updated if needed

---

## Anti-Patterns to Avoid
- ❌ Don't create new patterns when existing ones work
- ❌ Don't skip validation because "it should work"  
- ❌ Don't ignore failing tests - fix them
- ❌ Don't mix callbacks and promises - use async/await
- ❌ Don't hardcode values that should be config
- ❌ Don't catch all exceptions - be specific
- ❌ Don't use npm/npx - always use pnpm