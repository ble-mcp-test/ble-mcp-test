# Execute BASE PRP

Implement a feature using using the PRP file.

## PRP File: $ARGUMENTS

## Execution Process

**IMPORTANT**: Always use the TodoWrite tool to plan and track tasks throughout the conversation.

1. **Load PRP**
   - First, read `prp/README.md` to understand the PRP philosophy and standards
   - Then read the specified PRP file
   - Understand all context and requirements
   - Follow all instructions in the PRP and extend the research if needed
   - Ensure you have all needed context to implement the PRP fully
   - Do more web searches and codebase exploration as needed

2. **ULTRATHINK**
   - Think hard before you execute the plan. Create a comprehensive plan addressing all requirements.
   - Break down complex tasks into smaller, manageable steps using your todos tools.
   - Use the TodoWrite tool to create and track your implementation plan.
   - Identify implementation patterns from existing code to follow.

3. **Execute the plan**
   - Execute the PRP
   - Implement all the code

4. **Validate**
   - Run each validation command
   - Fix any failures
   - Re-run until all pass

5. **Complete**
   - Ensure all checklist items done
   - Run final validation suite
   - Report completion status
   - Read the PRP again to ensure you have implemented everything

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