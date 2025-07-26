name: "Project Rename PRP - web-ble-bridge to ble-mcp-test"
description: |

## Purpose
Rename the project from `@trakrf/web-ble-bridge` to `ble-mcp-test`, removing npm scoping and updating all references throughout the codebase, GitHub repository, and npm package.

## Core Principles
1. **Complete Rename**: Update all references to old name except historical (CHANGELOG entries)
2. **Preserve Functionality**: No functional changes, only naming updates
3. **Clean Migration**: Ensure smooth transition for developers and users
4. **Follow CLAUDE.md**: Use pnpm exclusively, no npm/npx commands
5. **Version 0.3.0**: This version has NOT been published yet

---

## Goal
Rename the project from `@trakrf/web-ble-bridge` to `ble-mcp-test` across all touchpoints including:
- npm package name (removing @trakrf scope)
- GitHub repository URL
- All documentation and code references
- Package binaries and examples

## Why
- Simplify package name by removing organizational scoping
- Better reflect the project's purpose: bridging BLE devices to MCP-compatible AI agents
- Make the package more discoverable and memorable
- Align naming with the project's evolution toward MCP integration

## What
Complete project rename including:
- Update package.json with new unscoped name
- Update all documentation to reference new name
- Replace all instances of old name in code comments and examples
- Update GitHub repository references
- Add rename notice to CHANGELOG for v0.3.0
- Deprecate old npm package after publishing new one

### Success Criteria
- [ ] All references to `@trakrf/web-ble-bridge` replaced with `ble-mcp-test`
- [ ] All references to `web-ble-bridge` (without scope) replaced appropriately
- [ ] Package.json updated with new name and repository URLs
- [ ] README.md updated with new header and installation instructions
- [ ] CHANGELOG.md includes v0.3.0 rename notice
- [ ] All tests pass with new naming
- [ ] Project builds successfully
- [ ] No references to old name remain (except historical CHANGELOG entries)

## All Needed Context

### Documentation & References
```yaml
# Current package.json structure
- file: package.json
  why: Shows current naming, repository URLs, bin names, and structure
  current_name: "@trakrf/web-ble-bridge"
  new_name: "ble-mcp-test"
  
# Migration script example
- file: prp/example/migrate-repo.sh
  why: Provides GitHub CLI commands for repository migration
  note: Manual process or script execution
  
# Project conventions
- file: CLAUDE.md
  why: Critical rules - use pnpm exclusively, never npm/npx
  
# Current README structure  
- file: README.md
  why: Main documentation requiring extensive updates
  key_sections: header, installation, examples, configuration
  
# Changelog format
- file: CHANGELOG.md
  why: Add v0.3.0 rename entry following existing format
```

### Current Codebase Structure
```bash
.
├── package.json          # "@trakrf/web-ble-bridge" → "ble-mcp-test"
├── README.md            # Update header, examples, installation
├── CHANGELOG.md         # Add v0.3.0 rename notice
├── docs/                # Check all .md files for references
├── scripts/             # Update any script references
├── src/                 # Check comments and string literals
├── tests/               # Check test descriptions
└── prp/                 # Update example scripts
```

### Known Gotchas
```typescript
// CRITICAL: Use pnpm exclusively - NEVER npm or npx
// Replace ALL instances of "npx @trakrf/web-ble-bridge" with "pnpm dlx ble-mcp-test"
// Version 0.3.0 has NOT been published to npm yet
// The old @trakrf/web-ble-bridge package exists at v0.2.0
// TrakRF sponsor links are OUT OF SCOPE - do not add
```

## Implementation Blueprint

### Data Models and Structure
```yaml
name_mappings:
  package_name:
    old: "@trakrf/web-ble-bridge"
    new: "ble-mcp-test"
  
  github_repo:
    old: "https://github.com/trakrf/web-ble-bridge"
    new: "https://github.com/ble-mcp-test/ble-mcp-test"
  
  binary_name:
    old: "web-ble-bridge"
    new: "ble-mcp-test"  # Assuming binary should match package name
    
  environment_prefix:
    old: "WEB_BLE_BRIDGE_"  # None exist yet
    new: "BLE_MCP_TEST_"    # For future use
    
  ascii_art: "[BLE]──●──[MCP]──●──[AI agent]"
```

### List of Tasks (in order)

```yaml
Task 1:
UPDATE package.json:
  - Change "name" from "@trakrf/web-ble-bridge" to "ble-mcp-test"
  - Update "homepage" to "https://github.com/ble-mcp-test/ble-mcp-test"
  - Update "repository.url" to "https://github.com/ble-mcp-test/ble-mcp-test.git"
  - Update "bugs.url" to "https://github.com/ble-mcp-test/ble-mcp-test/issues"
  - Update "description" to "Bridge Bluetooth devices to your AI coding assistant via Model Context Protocol"
  - Update "bin" entry from "web-ble-bridge" to "ble-mcp-test" (if appropriate)

Task 2:
UPDATE README.md:
  - Replace header "# web-ble-bridge" with new format including ASCII art
  - Update all installation examples from "@trakrf/web-ble-bridge" to "ble-mcp-test"
  - Replace all "npx @trakrf/web-ble-bridge" with "pnpm dlx ble-mcp-test"
  - Update all references to "web-ble-bridge" command to new binary name
  - Add section documenting the name change and migration

Task 3:
UPDATE CHANGELOG.md:
  - Add new v0.3.0 entry with BREAKING change notice
  - Include repository migration information
  - Follow existing format from v0.2.0 and v0.1.0 entries

Task 4:
SEARCH AND UPDATE documentation files:
  - Use grep to find all instances in docs/ directory
  - Update references while preserving context
  - Special attention to API.md, MCP-SERVER.md, MIGRATION.md

Task 5:
UPDATE code comments and examples:
  - Search src/ directory for old name references
  - Update comments maintaining clarity
  - Check test descriptions and names

Task 6:
UPDATE script files:
  - Check scripts/ directory for references
  - Update shell scripts that reference the package

Task 7:
REGENERATE package-lock:
  - Run "pnpm install" to update pnpm-lock.yaml with new name

Task 8:
VALIDATE all changes:
  - Run full test suite
  - Build the project
  - Verify no old references remain
```

### Integration Points
```yaml
PACKAGE_MANAGER:
  - command: "pnpm install"
  - purpose: "Regenerate lockfile with new package name"
  
BUILD_SYSTEM:
  - verify: "Binary output matches new name"
  - check: "Bundle naming is consistent"
  
DOCUMENTATION:
  - ensure: "All examples use pnpm dlx instead of npx"
  - format: "Use new ASCII art where appropriate"
```

## Validation Loop

### Level 1: Syntax & Style
```bash
# Verify no old package name remains
grep -r "@trakrf/web-ble-bridge" . --exclude-dir=node_modules --exclude-dir=.git --exclude="CHANGELOG.md" | grep -v "archive"
# Expected: No results (except possibly in this PRP file)

# Verify pnpm commands are used
grep -r "npx @trakrf/web-ble-bridge" . --exclude-dir=node_modules --exclude-dir=.git
# Expected: No results

# Run linting and type checking
pnpm run lint
pnpm run typecheck
# Expected: No errors
```

### Level 2: Build Verification
```bash
# Clean and rebuild
pnpm run clean
pnpm run build

# Verify binary name
ls -la dist/ | grep -E "(start-server|bin)"
# Expected: Files exist with consistent naming

# Check package.json is valid
pnpm pack --dry-run
# Expected: Shows ble-mcp-test-0.3.0.tgz
```

### Level 3: Test Suite
```bash
# Run all tests to ensure nothing broke
pnpm run test:all
# Expected: All tests pass

# Verify examples still work
pnpm run build
node dist/start-server.js --help 2>/dev/null || echo "Server starts correctly"
# Expected: No errors
```

### Level 4: Documentation Check
```bash
# Verify README has new header with ASCII art
head -5 README.md | grep -E "(ble-mcp-test|BLE.*MCP.*AI agent)"
# Expected: Both patterns found

# Check CHANGELOG has v0.3.0 entry
grep -A5 "## \[0.3.0\]" CHANGELOG.md
# Expected: Shows rename notice
```

## Final Validation Checklist
- [ ] Package.json has new name "ble-mcp-test" 
- [ ] All repository URLs updated to github.com/ble-mcp-test/ble-mcp-test
- [ ] README.md has new header with ASCII art
- [ ] All npm/npx commands replaced with pnpm equivalents
- [ ] CHANGELOG.md includes v0.3.0 rename entry
- [ ] No references to old name remain (except historical)
- [ ] All tests pass: `pnpm run test:all`
- [ ] Project builds successfully: `pnpm run build`
- [ ] Lockfile regenerated: `pnpm install`

---

## Anti-Patterns to Avoid
- ❌ Don't use npm or npx - always use pnpm/pnpm dlx
- ❌ Don't add TrakRF sponsor messages (out of scope)
- ❌ Don't change version number (stays 0.3.0)
- ❌ Don't modify historical CHANGELOG entries
- ❌ Don't change functional code, only naming
- ❌ Don't forget to update binary name in package.json
- ❌ Don't leave any TODO or FIXME comments

## Post-Implementation Steps (Manual)
1. Push changes to current repository
2. Create new GitHub organization and repository using migrate-repo.sh
3. Update git remote: `git remote set-url origin https://github.com/ble-mcp-test/ble-mcp-test.git`
4. Push to new repository
5. Publish v0.3.0 to npm as "ble-mcp-test"
6. Deprecate @trakrf/web-ble-bridge on npm with message pointing to new package