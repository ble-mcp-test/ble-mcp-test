# Writing Effective Feature Specifications

## What is a Spec?

A specification (spec) is the input document that describes what feature or functionality needs to be built. It serves as the source material for generating a comprehensive PRP (Product Requirements Prompt).

## Spec Structure

Use the template at `template.md` which includes four sections:

### 1. FEATURE
Clear, specific description of what needs to be built. Be explicit about:
- The exact functionality required
- User-facing behavior
- Technical requirements
- Success criteria

### 2. EXAMPLES
Provide concrete examples that help clarify the implementation:
- Code snippets showing desired patterns
- Links to similar features in the codebase
- Mock-ups or interface examples
- Input/output examples

### 3. DOCUMENTATION
List all relevant documentation that will help implement the feature:
- Official library documentation
- API references
- Blog posts or tutorials
- GitHub issues or discussions
- Internal documentation

### 4. OTHER CONSIDERATIONS
Include any constraints or special requirements:
- Performance requirements
- Security considerations  
- Browser/platform compatibility
- Dependencies or library versions
- Known issues or workarounds

## Best Practices

### DO:
- ✅ Be specific and unambiguous
- ✅ Include concrete examples
- ✅ Reference existing patterns in the codebase
- ✅ List all relevant documentation
- ✅ Mention any gotchas or edge cases
- ✅ Specify validation criteria

### DON'T:
- ❌ Be vague or use ambiguous language
- ❌ Assume context that isn't provided
- ❌ Skip "obvious" requirements
- ❌ Forget about error cases
- ❌ Omit performance or security needs

## Example Spec

```markdown
## FEATURE:
Add WebSocket reconnection logic with exponential backoff to handle network interruptions gracefully.

## EXAMPLES:
- Similar pattern in `src/transport/http-client.ts` lines 45-89
- Exponential backoff: 1s, 2s, 4s, 8s, max 30s
- Should emit 'reconnecting' and 'reconnected' events

## DOCUMENTATION:
- https://github.com/websockets/ws#how-to-detect-and-close-broken-connections
- https://developer.mozilla.org/en-US/docs/Web/API/WebSocket/readyState
- Internal pattern: src/utils/retry.ts

## OTHER CONSIDERATIONS:
- Must work in both Node.js and browser environments
- Should not reconnect if explicitly closed by user
- Maximum retry attempts: 5
- Must preserve message queue during reconnection
```

## From Spec to PRP

Once you've written a spec:

1. Save it in `prp/spec/your-feature-name.md`
2. Run `/generate-prp prp/spec/your-feature-name.md`
3. The AI will research and generate a comprehensive PRP
4. Review the generated PRP before execution

## Tips for Success

1. **More context is better**: The AI can filter information, but can't guess missing details
2. **Use real examples**: Point to actual code in the project when possible
3. **Be explicit about constraints**: Don't assume the AI knows project conventions
4. **Include validation criteria**: How will we know the feature works correctly?

Remember: A good spec leads to a good PRP, which leads to successful implementation!