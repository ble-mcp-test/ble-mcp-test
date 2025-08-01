#!/bin/bash

# GitHub Repository Migration Script with Organization Support
# Copies settings from old repo to new repo and sets up branch protection

OLD_REPO="trakrf/web-ble-bridge"
NEW_ORG="ble-mcp-test"
NEW_REPO="ble-mcp-test/ble-mcp-test"

echo "=== GitHub Repository Migration Script ==="
echo "From: $OLD_REPO"
echo "To:   $NEW_REPO (in new organization)"
echo ""

# Step 0: Verify org exists
echo "🏢 Checking if organization $NEW_ORG exists..."
gh api /orgs/$NEW_ORG &> /dev/null
if [ $? -ne 0 ]; then
    echo "❌ Organization $NEW_ORG not found!"
    echo ""
    echo "Please create it first:"
    echo "1. Go to https://github.com/organizations/new"
    echo "2. Use '$NEW_ORG' as the organization name"
    echo "3. Choose the free plan"
    echo "4. Run this script again"
    exit 1
fi
echo "✅ Organization found!"
echo ""

# Step 1: Get settings from old repo
echo "📋 Fetching settings from $OLD_REPO..."
REPO_DATA=$(gh repo view $OLD_REPO --json description,homepageUrl,topics,isPrivate,hasIssuesEnabled,hasProjectsEnabled,hasWikiEnabled)

# Extract values
DESCRIPTION=$(echo $REPO_DATA | jq -r '.description // empty')
HOMEPAGE=$(echo $REPO_DATA | jq -r '.homepageUrl // empty')
TOPICS=$(echo $REPO_DATA | jq -r '.topics // [] | join(",")')
IS_PRIVATE=$(echo $REPO_DATA | jq -r '.isPrivate')
HAS_ISSUES=$(echo $REPO_DATA | jq -r '.hasIssuesEnabled')
HAS_PROJECTS=$(echo $REPO_DATA | jq -r '.hasProjectsEnabled')
HAS_WIKI=$(echo $REPO_DATA | jq -r '.hasWikiEnabled')

# Step 2: Create new repo in organization
echo "🚀 Creating $NEW_REPO in organization..."

CREATE_ARGS=""
if [ "$IS_PRIVATE" = "true" ]; then
    CREATE_ARGS="--private"
else
    CREATE_ARGS="--public"
fi

if [ -n "$DESCRIPTION" ]; then
    CREATE_ARGS="$CREATE_ARGS --description \"$DESCRIPTION\""
fi

if [ -n "$HOMEPAGE" ]; then
    CREATE_ARGS="$CREATE_ARGS --homepage \"$HOMEPAGE\""
fi

# Create the repo in the organization
eval "gh repo create $NEW_REPO $CREATE_ARGS --clone=false"

# Step 3: Update additional settings
echo "⚙️  Configuring repository settings..."

EDIT_ARGS=""
if [ -n "$TOPICS" ]; then
    EDIT_ARGS="$EDIT_ARGS --add-topic \"$TOPICS\""
fi

EDIT_ARGS="$EDIT_ARGS --enable-issues=$HAS_ISSUES"
EDIT_ARGS="$EDIT_ARGS --enable-projects=$HAS_PROJECTS"
EDIT_ARGS="$EDIT_ARGS --enable-wiki=$HAS_WIKI"
EDIT_ARGS="$EDIT_ARGS --default-branch main"

eval "gh repo edit $NEW_REPO $EDIT_ARGS"

# Step 4: Wait for repo to be ready
echo "⏳ Waiting for repository to be ready..."
sleep 3

# Step 5: Set up branch protection
echo "🔒 Setting up branch protection for main branch..."

# Create branch protection rules
# Note: The branch must exist first, so this should be run after pushing code
gh api \
  --method PUT \
  -H "Accept: application/vnd.github+json" \
  -H "X-GitHub-Api-Version: 2022-11-28" \
  /repos/$NEW_REPO/branches/main/protection \
  -f required_status_checks='null' \
  -f enforce_admins=false \
  -f required_pull_request_reviews='{"dismiss_stale_reviews":true,"require_code_owner_reviews":false,"required_approving_review_count":1}' \
  -f restrictions='null' \
  -f allow_force_pushes=false \
  -f allow_deletions=false \
  -f block_creations=false \
  -f required_conversation_resolution=false

if [ $? -eq 0 ]; then
    echo "✅ Branch protection rules applied successfully!"
else
    echo "⚠️  Branch protection failed - the main branch might not exist yet."
    echo "   Run this after pushing code to the new repo:"
    echo "   gh api --method PUT /repos/$NEW_REPO/branches/main/protection \\"
    echo "     -f required_pull_request_reviews='{\"required_approving_review_count\":1}' \\"
    echo "     -f allow_force_pushes=false"
fi

echo ""
echo "=== Migration Summary ==="
echo "✅ Organization: https://github.com/$NEW_ORG"
echo "✅ Repository created: https://github.com/$NEW_REPO"
echo "✅ Settings copied from $OLD_REPO"
echo ""
echo "Next steps:"
echo "1. Update your git remote: git remote set-url origin https://github.com/$NEW_REPO.git"
echo "2. Push your code: git push -u origin main"
echo "3. Push all tags: git push --tags"
echo "4. Archive the old repository at https://github.com/$OLD_REPO/settings"
echo ""
echo "Optional organization setup:"
echo "- Add a profile README at https://github.com/$NEW_ORG/.github"
echo "- Set organization profile picture and description"
echo "- Configure organization settings as needed"