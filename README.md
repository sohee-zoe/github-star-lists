# GitHub Star List Organizer

Organize GitHub starred repositories into GitHub Star Lists. The CLI creates missing lists, classifies starred repositories with configurable rules, writes a dry-run plan first, and can sync list descriptions and visibility.

## Install

Run without installing:

```bash
npx github-star-lists
```

Or install globally:

```bash
npm install -g github-star-lists
github-star-lists
```

## Authentication

Use GitHub CLI:

```bash
gh auth login
gh auth refresh -h github.com -s user -s repo
```

Or provide a token:

```bash
GITHUB_TOKEN=ghp_xxx npx github-star-lists
```

The token needs the classic `user` scope. Add `repo` if your starred repositories include private repositories.

## Quick Start

Most users should start with the guided flow:

```bash
npx github-star-lists wizard
```

The wizard asks you to choose:

- preview or apply
- public, private, or config-based list visibility
- whether to use existing lists only
- whether to sync descriptions
- whether to sync existing list visibility
- whether to scan all stars or only the newest N

To create a local config first, use the general preset:

```bash
npx github-star-lists init
```

Then preview. This does not write to GitHub:

```bash
npx github-star-lists
```

Apply changes:

```bash
npx github-star-lists --apply
```

## Setup Your Config

`init` writes `star-lists.config.json` in the current directory. The default preset is `general`.

```bash
npx github-star-lists init
npx github-star-lists init --preset general
```

Available presets:

```bash
npx github-star-lists init --list-presets
npx github-star-lists init --preset ai
npx github-star-lists init --preset robotics
npx github-star-lists init --preset webdev
```

If you already use GitHub Star Lists, generate config from those lists:

```bash
npx github-star-lists init --from-existing-lists
```

This copies list names, descriptions, and visibility. Keywords are left empty, while topics are lightly suggested from list names.

To generate a non-AI config suggestion from your starred repositories:

```bash
npx github-star-lists suggest-config
npx github-star-lists suggest-config --limit=200
```

This scans starred repo topics, languages, and description keywords, then writes:

```text
out/suggested-config.json
```

After reviewing that file, run with it:

```bash
npx github-star-lists --config out/suggested-config.json
```

The flags below are useful for automation or repeatable workflows.

## Visibility

New lists are public by default. Before applying, the CLI prints lists as `[x] public` or `[x] private` and asks for confirmation.

```bash
npx github-star-lists --apply
npx github-star-lists --all-private --apply
npx github-star-lists --all-public --apply
```

Sync existing configured lists to the chosen visibility:

```bash
npx github-star-lists --all-public --sync-list-visibility --apply
npx github-star-lists --all-private --sync-list-visibility --apply
```

Skip confirmation in automation:

```bash
npx github-star-lists --apply --yes
```

## Common Commands

Scan only the newest 50 stars:

```bash
npx github-star-lists --limit=50
```

Use existing lists only:

```bash
npx github-star-lists --existing-only
npx github-star-lists --existing-only --apply
```

Fill empty list descriptions from config:

```bash
npx github-star-lists --sync-list-descriptions
npx github-star-lists --sync-list-descriptions --apply
```

Only sync list metadata without changing repository assignments:

```bash
npx github-star-lists --sync-list-descriptions --only-list-metadata --apply
npx github-star-lists --sync-list-visibility --all-public --only-list-metadata --apply
```

Overwrite existing descriptions:

```bash
npx github-star-lists --sync-list-descriptions --overwrite-list-descriptions --apply
```

Hide progress output:

```bash
npx github-star-lists --quiet
```

## Configuration

By default the CLI uses the first existing file from:

1. `star-lists.config.json`
2. `config/star-lists.json`
3. the packaged `general` preset

Use a specific config:

```bash
npx github-star-lists --config ./my-star-lists.json
```

Each list can define:

```json
{
  "name": "LLM",
  "description": "Large language models, RAG, inference, evals, and LLM application tooling.",
  "isPrivate": false,
  "keywords": ["llm", "rag", "embedding", "inference"],
  "topics": ["llm", "rag", "embeddings"]
}
```

`--all-private` and `--all-public` override per-list `isPrivate` values.

## How Classification Works

The CLI first checks repository name, description, homepage, primary language, and topics. Repositories that do not meet the score threshold are checked again using their README. README matches are shown in the plan as `readme:<keyword>`.

Existing list assignments are preserved by default. The CLI only adds newly matched lists unless you change `preserveExistingAssignments` in config.

## Output

Dry-run and apply commands write:

```text
out/plan.md
out/plan.json
```

`--existing-only` writes `out/plan-existing-only.md` and `out/plan-existing-only.json`.

`--only-list-metadata` writes `out/plan-list-metadata.md` and `out/plan-list-metadata.json`.

## Local Development

```bash
npm run check
npm run plan
npm run apply
```
