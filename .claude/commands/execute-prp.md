# Execute BASE PRP

Implement a feature using using the PRP file.

## PRP File: $ARGUMENTS

## Execution Process

**IMPORTANT**: Always use the TodoWrite tool to plan and track tasks throughout the conversation.

**CRITICAL**: This PRP uses VALIDATION GATES, not optional success criteria. Each gate MUST pass before proceeding to the next. No exceptions, no bypassing, no "will fix later."

1. **Load PRP**
   - First, read `prp/README.md` to understand the PRP philosophy and standards
   - Then read the specified PRP file
   - Understand all context and requirements
   - Follow all instructions in the PRP and extend the research if needed
   - Ensure you have all needed context to implement the PRP fully
   - Do more web searches and codebase exploration as needed

2. **ULTRATHINK AND GATE PLANNING**
   - Read ALL validation gates in the PRP first - these are your hard requirements
   - Create TodoWrite items for EACH validation gate as separate todos
   - Plan implementation to satisfy each gate's pass criteria
   - Identify which gates depend on others and plan sequence accordingly
   - Break down complex tasks into smaller steps, but always keep gate requirements in mind
   - NO implementation work begins until you understand all gate requirements

3. **Execute the plan**
   - Execute the PRP
   - Implement all the code

4. **Execute Validation Gates (MANDATORY ENFORCEMENT)**
   
   **Gate Execution Protocol:**
   - Identify all gates in PRP (marked with 🚪)
   - Execute gates in numerical order ONLY
   - For each gate:
     
     **Step 1**: Announce gate execution
     - State: "Executing Gate [N]: [Name]"
     - Describe pass criteria
     
     **Step 2**: Run validation commands exactly as written
     - Copy commands from PRP exactly
     - Run with Bash tool
     - Capture full output
     
     **Step 3**: Evaluate pass criteria
     - Compare output to gate's pass criteria
     - Gate PASSES only if ALL criteria met exactly
     - If ANY criterion fails, gate FAILS
     
     **Step 4**: Gate outcome handling
     - **If PASS**: State "Gate [N] PASSED" and proceed to Gate [N+1]
     - **If FAIL**: State "Gate [N] FAILED" and STOP ALL WORK
       - Analyze failure reason
       - Fix the underlying issue
       - Re-run Gate [N] from Step 1
       - Continue until gate passes
   
   **ENFORCEMENT RULES:**
   - Gate N+1 cannot begin until Gate N shows "PASSED"
   - NO bypassing with excuses like "close enough" or "minor issue"
   - NO deferring with "will fix in next version"
   - ALL gates must show "PASSED" before claiming completion

   **REGRESSION PROTECTION:**
   - Create git checkpoint after each gate passes: `git commit -m "Gate [N] passed - checkpoint"`
   - **CRITICAL**: If ANY gate fails and requires code changes, ALL gates must be re-run from Gate 1
   - Track regression cycles - maximum 3 full cycles allowed per PRP execution
   - If max cycles exceeded: STOP execution, reassess approach, potentially roll back to stable checkpoint

   **Code Change Protocol (When Gate Fails):**
   1. **Assess Impact**: What files need modification? Which gates could be affected?
   2. **Minimal Fix**: Make smallest possible change to address specific failure
   3. **Regression Run**: Re-execute ALL gates from Gate 1 (not just the failed gate)
   4. **Cycle Tracking**: Increment regression cycle counter
   5. **Limit Check**: If cycle count > 3, STOP and escalate

   **Death Spiral Prevention:**
   - **Maximum 3 Regression Cycles**: After 3 full runs, stop execution
   - **Escalation Path**: If max exceeded, analyze if different approach needed
   - **Rollback Option**: Can return to last stable git checkpoint and try different fix strategy
   - **Minimal Change Principle**: Avoid "while I'm here" improvements during gate fixing

5. **Complete (Only After All Gates Pass)**
   - Verify ALL validation gates have passed successfully
   - Confirm implementation meets every gate's pass criteria
   - NO completion claim until every gate shows "PASSED" status
   - Read the PRP again to verify 100% requirement fulfillment
   - Report completion status with gate-by-gate evidence

6. **Stage for deployment**
   - Bump the semver patch version for the project in the appropriate place unless explicitly told to bump major or minor
   - Be sure that you have fully updated all project documentation to reflect the current project state and version
   - Be sure that you are on a feature or bugfix branch with no unrelated changes. generate-prp should have created one. Warn the user if not
   - Commit the changes that you have made
   - Push the branch to github
   - Create a pull request for the user to review

7. **Reference the PRP**
   - You can always reference the PRP again if needed

Note: If validation fails, use error patterns in PRP to fix and retry.