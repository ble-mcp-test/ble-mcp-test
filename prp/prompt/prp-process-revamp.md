name: "PRP Process Revamp - Directory Restructuring and Organization"
description: |

## Purpose
Restructure the PRP (Product Requirements Prompt) process to be wholly contained within one `prp` directory, making it more organized and ergonomic for developers.

## Core Principles
1. **Ergonomics First**: Use lowercase "prp" to spare developers from carpal tunnel
2. **Clear Organization**: Separate active work from archives
3. **Self-Documenting**: Include comprehensive README and templates
4. **Maintain Compatibility**: Update all references to new paths

---

## Goal
Reorganize the PRP process structure from scattered directories (`./PRPs`, `./docs`, `./examples`) into a unified `./prp` directory with clear subdirectories for specs, prompts, examples, and archives.

## Why
- **Developer Ergonomics**: Typing "PRPs" requires constant shift key usage
- **Better Organization**: All PRP-related content in one place
- **Clear Lifecycle**: Separate active from completed work
- **Improved Discovery**: Centralized documentation and templates

## What
Transform the current scattered PRP structure into a well-organized directory tree with updated slash commands and documentation.

### Success Criteria
- [ ] All PRP content moved to new `./prp` directory structure
- [ ] Slash commands updated and working
- [ ] README and templates created
- [ ] No broken references in codebase
- [ ] Only API.md and MIGRATION.md remain in `./docs`

## All Needed Context

### Documentation & References
```yaml
- file: /Users/mike/trakrf/web-ble-bridge/PRPs/templates/prp_base.md
  why: Current PRP template to move and potentially update

- file: /Users/mike/trakrf/web-ble-bridge/.claude/commands/generate-prp.md
  why: Slash command needing path updates (line 29, 58)
  
- file: /Users/mike/trakrf/web-ble-bridge/.claude/commands/execute-prp.md
  why: Slash command needing reference updates
  
- file: /Users/mike/trakrf/web-ble-bridge/CLAUDE.md
  why: Contains PRP glossary entry

- url: https://github.com/coleam00/context-engineering-intro/blob/main/README.md
  why: Context engineering best practices for README content
  
- url: https://www.philschmid.de/context-engineering
  why: Dynamic context construction principles
  
- url: https://github.com/Wirasm/PRPs-agentic-eng
  why: PRP structure and validation approaches
```

### Current Directory Structure
```bash
./PRPs/
├── extract-from-noble-cs108.md
└── templates/
    └── prp_base.md

./docs/
├── API.md
├── MIGRATION.md
├── REVAMP-PRP.md
└── [other docs to be moved]

./examples/  # Does not exist
```

### Desired Directory Structure
```bash
./prp/
├── README.md              # PRP process documentation
├── spec/                  # Feature specifications
│   ├── README.md         # Spec writing guide
│   ├── template.md       # Empty spec template
│   └── revamp-prp.md     # Moved from docs/
├── prompt/               # Generated PRPs
│   ├── extract-from-noble-cs108.md  # Moved from PRPs/
│   └── prp-process-revamp.md        # This PRP
├── example/              # Code examples for PRPs
│   └── README.md         # How to use examples
├── template/             # PRP templates
│   └── prp_base.md      # Moved from PRPs/templates/
└── archive/             # Completed work
    ├── spec/
    ├── prompt/
    └── example/

./docs/
├── API.md               # Remains
└── MIGRATION.md         # Remains
```

### Known Constraints
- Package manager: Must use pnpm (not npm/npx)
- Git workflow: Never commit to main, use feature branches
- File references: Update all paths in slash commands and documentation

## Implementation Blueprint

### Directory Structure Creation
```bash
# Create new directory structure
mkdir -p prp/{spec,prompt,example,template,archive/{spec,prompt,example}}
```

### Task List (in order)

```yaml
Task 1: Create base directory structure
CREATE directories:
  - prp/
  - prp/spec/
  - prp/prompt/
  - prp/example/
  - prp/template/
  - prp/archive/spec/
  - prp/archive/prompt/
  - prp/archive/example/

Task 2: Create PRP process README
CREATE prp/README.md:
  - Explain PRP philosophy (context engineering)
  - Document directory structure
  - Outline PRP workflow
  - Include best practices from research
  - Add links to templates and examples

Task 3: Create spec template and README
CREATE prp/spec/template.md:
  - Basic structure: FEATURE, EXAMPLES, DOCUMENTATION, OTHER CONSIDERATIONS
  - Clear placeholders and instructions
  
CREATE prp/spec/README.md:
  - How to write effective specs
  - What makes a good feature specification
  - Examples of well-written specs

Task 4: Create example directory README
CREATE prp/example/README.md:
  - Purpose of example directory
  - How to structure examples
  - Best practices for example code

Task 5: Move existing files
MOVE files:
  - PRPs/templates/prp_base.md → prp/template/prp_base.md
  - PRPs/extract-from-noble-cs108.md → prp/prompt/extract-from-noble-cs108.md
  - docs/REVAMP-PRP.md → prp/spec/revamp-prp.md
  - PRPs/prp-process-revamp.md → prp/prompt/prp-process-revamp.md (this file after creation)

Task 6: Update generate-prp slash command
MODIFY .claude/commands/generate-prp.md:
  - Line 29: "PRPs/templates/prp_base.md" → "prp/template/prp_base.md"
  - Line 58: "PRPs/{feature-name}.md" → "prp/prompt/{feature-name}.md"

Task 7: Update execute-prp slash command
MODIFY .claude/commands/execute-prp.md:
  - Update any PRP path references if needed
  - Ensure compatibility with new structure

Task 8: Clean up old directories
DELETE directories:
  - PRPs/ (after verifying all files moved)
  - Remove REVAMP-PRP.md from docs/

Task 9: Verify no broken references
SEARCH for old paths:
  - Search for "PRPs/" references
  - Search for "docs/REVAMP" references
  - Fix any found references
```

## Validation Loop

### Level 1: Structure Verification
```bash
# Verify new directory structure exists
ls -la prp/
tree prp/

# Expected output: All subdirectories present
```

### Level 2: File Movement Verification
```bash
# Check files moved correctly
ls prp/prompt/extract-from-noble-cs108.md
ls prp/template/prp_base.md
ls prp/spec/revamp-prp.md

# Verify old locations empty
ls PRPs/ 2>/dev/null || echo "PRPs directory removed successfully"
```

### Level 3: Slash Command Testing
```bash
# Test generate-prp command references correct template
grep -n "prp/template/prp_base.md" .claude/commands/generate-prp.md

# Test output path is updated
grep -n "prp/prompt/" .claude/commands/generate-prp.md
```

### Level 4: Reference Check
```bash
# Search for any remaining old references
rg "PRPs/" --type md
rg "docs/REVAMP-PRP" --type md

# Expected: No results (all references updated)
```

### Level 5: Documentation Completeness
```bash
# Verify all README files exist
ls prp/README.md
ls prp/spec/README.md
ls prp/example/README.md

# Check docs directory only has allowed files
ls docs/
# Expected: Only API.md and MIGRATION.md
```

## Final Validation Checklist
- [ ] Directory structure matches specification
- [ ] All files moved to correct locations
- [ ] Slash commands updated and functional
- [ ] No broken references to old paths
- [ ] All README files created with content
- [ ] Template files accessible in new location
- [ ] Only API.md and MIGRATION.md remain in docs/
- [ ] Old PRPs directory removed
- [ ] Git tracks all changes properly

---

## Anti-Patterns to Avoid
- ❌ Don't leave any files in old locations
- ❌ Don't forget to update path references
- ❌ Don't create empty README files
- ❌ Don't break existing slash commands
- ❌ Don't commit directly to main branch

## Implementation Notes
- Use `git mv` for moving files to preserve history
- Create meaningful commit messages for each step
- Test slash commands after updates
- Ensure all paths use forward slashes for cross-platform compatibility

---

**Confidence Score: 9/10**

This PRP provides comprehensive context for reorganizing the PRP process. The task is straightforward file movement and creation with clear validation steps. The only minor complexity is ensuring all references are updated correctly, which the validation steps address.