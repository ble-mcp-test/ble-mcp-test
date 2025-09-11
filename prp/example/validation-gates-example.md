# Validation Gates Example: Transforming Success Criteria

## Problem: Weak Success Criteria (Old Approach)

**From fix-noble-client.md - WEAK:**
```markdown
### Success Criteria
- [ ] NodeBleClient uses service-UUID based discovery (not device name)
- [ ] sessionId is required (consistent with browser mock)
- [ ] Single `connect()` call establishes full BLE connection (no requestDevice() needed)
- [ ] Integration test validates NodeBleClient → Bridge → Hardware communication path
- [ ] API is simpler and more Node.js appropriate than Web Bluetooth emulation
- [ ] Tests pass before npm publish (prevents broken releases)
```

**Why This Fails:**
- Checkboxes can be rationalized as "mostly done"
- Subjective criteria like "simpler" can be argued
- No enforcement mechanism
- No specific commands to verify completion
- Can be skipped or deferred as "tech debt"

## Solution: Validation Gates (New Approach)

**Transformed to STRONG validation gates:**

```markdown
### Validation Gates (MANDATORY SEQUENCE - NO EXCEPTIONS)

> **ENFORCEMENT**: Each gate MUST pass before proceeding to the next. No bypassing, no "tech debt" deferrals, no excuses.

**🚪 Gate 1: Syntax and Type Safety**
- **Validation Commands**: `pnpm run typecheck && pnpm run lint`
- **Pass Criteria**: Zero TypeScript errors, zero ESLint errors, exit code 0
- **Failure Action**: Fix each error individually, re-run until clean
- **Blocker**: Cannot proceed to Gate 2 until this passes

**🚪 Gate 2: API Structure Compliance**
- **Validation Commands**: 
  ```bash
  # Verify sessionId is required
  grep -n "sessionId.*required" src/node/NodeBleClient.ts
  # Verify requestDevice method removed  
  grep -n "requestDevice" src/node/NodeBleClient.ts && echo "FAIL: requestDevice still exists" || echo "PASS: requestDevice removed"
  # Verify service-UUID discovery parameters
  grep -n "deviceId\|deviceName" src/node/NodeBleClient.ts
  ```
- **Pass Criteria**: 
  - sessionId validation throws error for missing values
  - requestDevice method does not exist (grep returns no results)
  - deviceId/deviceName optional parameters are supported
- **Failure Action**: Modify API to exact specification, re-run verification
- **Dependencies**: Gate 1 must pass first
- **Blocker**: Cannot proceed to Gate 3 until this passes

**🚪 Gate 3: Unit Test Coverage**
- **Validation Commands**: `pnpm run test tests/unit/node-client.test.ts --reporter=verbose`
- **Pass Criteria**: 
  - 100% test pass rate (no skipped/failed tests)
  - sessionId required validation test passes
  - Constructor parameter validation test passes
  - Optional deviceId/deviceName test passes
- **Failure Action**: Write missing tests, fix failing tests, re-run until 100% pass
- **Dependencies**: Gates 1 and 2 must pass first
- **Blocker**: Cannot proceed to Gate 4 until this passes

**🚪 Gate 4: Integration Test Validation**
- **Validation Commands**: 
  ```bash
  pnpm run test tests/integration/node-client.test.ts --reporter=verbose
  node examples/node-client-example.js
  ```
- **Pass Criteria**: 
  - Integration test connects and executes test command successfully
  - Example script completes without errors showing: connection → write → notification received
  - End-to-end path validated: NodeBleClient → Bridge → Hardware → Response
- **Failure Action**: Debug connection issues, fix bridge communication, verify hardware, re-run tests
- **Dependencies**: Gates 1, 2, and 3 must pass first
- **Blocker**: Cannot claim completion until this passes
```

## Key Differences

| Old Success Criteria | New Validation Gates |
|---------------------|-------------------|
| "sessionId is required" | **Command**: `grep -n "sessionId.*required" src/...` <br>**Pass**: Error thrown for missing sessionId |
| "API is simpler" | **Command**: `grep -n "requestDevice" src/...` <br>**Pass**: Method does not exist (objective) |
| "Tests pass" | **Command**: `pnpm run test --reporter=verbose` <br>**Pass**: 100% pass rate with specific validations |
| "Integration test validates" | **Command**: `node examples/node-client-example.js` <br>**Pass**: Successful execution with real hardware response |

## Enforcement Benefits

1. **Objective Criteria**: Each gate has measurable pass/fail conditions
2. **Executable Validation**: Every requirement can be verified by running commands
3. **Sequential Dependencies**: Cannot skip ahead or work on later gates first  
4. **Evidence-Based**: Command output provides proof of completion
5. **No Bypass Mechanism**: No "close enough" or "will fix later" exceptions
6. **Iterative Fixing**: Failed gates must be fixed and re-run until they pass

## Implementation Pattern

When executing PRPs with validation gates:

1. **Parse Gates**: Identify all 🚪 gates in numerical order
2. **Execute Sequentially**: Gate N+1 cannot start until Gate N passes
3. **Announce Progress**: "Executing Gate 1: Syntax and Type Safety"
4. **Run Commands**: Copy validation commands exactly, run with Bash tool
5. **Evaluate Results**: Compare output to pass criteria objectively
6. **Handle Outcomes**: 
   - **PASS**: "Gate 1 PASSED" → proceed to Gate 2
   - **FAIL**: "Gate 1 FAILED" → fix issues → re-run Gate 1
7. **No Completion Until All Pass**: Only claim success when all gates show "PASSED"

This system eliminates the frustration of unclear requirements and ensures every PRP requirement is actually met before claiming completion.

## Regression Protection and Death Spiral Prevention

### The Regression Problem
**Scenario**: Gate 1 (syntax) passes, Gate 2 (unit tests) passes, Gate 3 (integration) fails  
**Fix Attempt**: Modify `NodeBleClient.ts` to fix integration issue  
**Result**: Fix breaks unit tests that were previously passing

### Regression Protection Protocol

**Rule**: If ANY gate fails and requires code changes, ALL gates must be re-run from Gate 1

**Example Execution Flow:**
```markdown
Cycle 1:
✅ Gate 1: Syntax passed
✅ Gate 2: Unit tests passed  
❌ Gate 3: Integration failed - sessionId validation not working

Code Change: Fix sessionId validation in constructor
** REGRESSION RUN REQUIRED **

git commit -m "Gate 2 passed - checkpoint"

Cycle 2 (Full Regression):
✅ Gate 1: Syntax passed
❌ Gate 2: Unit tests failed - constructor change broke existing tests  
🚫 Gate 3: Not executed (dependency failed)

Code Change: Fix unit tests to match new constructor
** REGRESSION RUN REQUIRED **

Cycle 3 (Full Regression):
✅ Gate 1: Syntax passed
✅ Gate 2: Unit tests passed
✅ Gate 3: Integration passed

SUCCESS: All gates passed
```

### Death Spiral Prevention

**Maximum Regression Cycles**: 3 per PRP execution

**Example Death Spiral Scenario:**
```markdown
Cycle 1: Gate 3 fails → fix breaks Gate 2
Cycle 2: Gate 2 fails → fix breaks Gate 1  
Cycle 3: Gate 1 fails → fix breaks Gate 3
Cycle 4: STOP - Maximum cycles exceeded

** ESCALATION REQUIRED **
Options:
1. Roll back to last stable checkpoint: "Gate 2 passed - checkpoint"
2. Reassess fix strategy - perhaps need different approach
3. Break down changes into smaller, more targeted fixes
4. Consider if PRP requirements need clarification
```

### Change Impact Assessment

**Before making ANY code changes, assess:**

```markdown
Impact Assessment Checklist:
- [ ] What files will be modified?
- [ ] Which validation gates test these files?
- [ ] Are there alternative fixes with smaller impact?
- [ ] Can we make multiple smaller changes instead of one large change?

Example Assessment:
Change needed: Fix sessionId validation
Files affected: src/node/NodeBleClient.ts, src/node/types.ts
Gates affected: 
- Gate 1: Syntax (TypeScript compilation)  
- Gate 2: Unit tests (constructor tests)
- Gate 3: Integration (sessionId behavior)

Risk: HIGH - affects all gates
Strategy: Make minimal change to constructor only, don't modify types.ts yet
```

### Minimal Change Principle

**Do:**
- Fix ONE specific failing test at a time
- Make smallest possible code change
- Avoid refactoring during gate execution
- Focus only on the failing gate's requirements

**Don't:**
- "While I'm here" improvements
- Wholesale refactoring
- Multiple unrelated changes in one fix
- Optimizations that don't address gate failure

### Practical Example: Minimal Fix

**Gate 3 Failure**: Integration test can't connect - sessionId missing validation

**❌ Large Change (High Regression Risk):**
```typescript
// Refactor entire constructor, add validation helper, update types
export class NodeBleClient {
  constructor(options: NodeBleClientOptions) {
    this.validateAndSetOptions(options); // New helper method
    this.setupConnectionManager(); // New abstraction
    // ... 20 lines of refactored code
  }
}
```

**✅ Minimal Change (Low Regression Risk):**
```typescript
// Add only the missing sessionId check
export class NodeBleClient {
  constructor(options: NodeBleClientOptions) {
    if (!options.sessionId) {
      throw new Error('sessionId is required');
    }
    // ... rest unchanged
  }
}
```

### Success Metrics

**Regression-Protected PRP execution should achieve:**
1. **Gate Completion**: All gates pass without regression failures
2. **Cycle Efficiency**: Complete within 3 regression cycles maximum  
3. **Stable Checkpoints**: Git history shows clear gate-by-gate progress
4. **Minimal Changes**: Small, targeted fixes rather than large refactors
5. **No Death Spirals**: No endless loop of breaking/fixing different gates

This system ensures that gate enforcement remains strict while preventing the frustration of endless regression cycles.